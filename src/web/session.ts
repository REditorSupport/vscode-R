import * as vscode from 'vscode';
import { ChannelType, WebR } from 'webr';
import { OutputQueue } from '../interactive/outputQueue';
import { WebRConsole, type WebRConsoleEvent } from '../webr/console';
import { WEBR_BASE_URL } from '../webr/runtime';
import { sessionDirectory } from './files';

interface ActiveCell {
    execution: vscode.NotebookCellExecution;
    output: OutputQueue;
    pending: ({ type: 'stdout' | 'stderr'; text: string } | { type: 'plot'; png: Uint8Array })[];
    remaining: number;
    truncated: boolean;
    outputError?: unknown;
    input: vscode.CancellationTokenSource;
}

export class BrowserSession implements vscode.Disposable {
    private readonly supportsInterrupt =
        globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';
    private worker?: { runtime: WebR; console: WebRConsole; ready: Promise<void> };
    private current?: ActiveCell;
    private queue = Promise.resolve();
    private executionOrder = 0;
    private failed?: Error;
    private readonly outputLimit =
        1024 * 1024 * vscode.workspace.getConfiguration('r').get('interactive.maxOutputSizeMiB', 4);
    private closed = false;
    private readonly lifetime = new AbortController();

    constructor(private readonly controller: vscode.NotebookController) {}

    // Queue file operations and submissions together. A stopped generation must
    // never execute work against a replacement session or a closed worker.
    run<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(() => {
            if (this.closed) {
                throw new Error('This webR session has ended.');
            }
            if (this.failed) {
                throw this.failed;
            }
            return operation();
        });
        this.queue = result.then(
            () => {},
            () => {},
        );
        return result;
    }

    private getWorker() {
        if (this.closed) {
            throw new Error('This webR session has ended.');
        }
        if (!this.worker) {
            const runtime = new WebR({
                baseUrl: WEBR_BASE_URL,
                homedir: sessionDirectory,
                channelType: this.supportsInterrupt
                    ? ChannelType.SharedArrayBuffer
                    : ChannelType.PostMessage,
            });
            const session = new WebRConsole(
                runtime,
                (event) => this.onEvent(event),
                this.supportsInterrupt,
                (error) => {
                    this.failed = new Error(
                        'The webR worker ended. Restart the session to run more code.',
                        { cause: error },
                    );
                },
            );
            const ready = session.start().catch((error: unknown) => {
                session.close();
                if (this.worker?.console === session) {
                    this.worker = undefined;
                }
                throw error;
            });
            this.worker = { runtime, console: session, ready };
        }
        return this.worker;
    }

    async files<T>(operation: (runtime: WebR) => Promise<T>): Promise<T> {
        return this.run(async () => {
            const worker = this.getWorker();
            await worker.ready;
            return operation(worker.runtime);
        });
    }

    async evaluate(cell: vscode.NotebookCell): Promise<void> {
        // start/clear even if loading fails so the error is visible in its cell.
        const execution = this.controller.createNotebookCellExecution(cell);
        const active: ActiveCell = {
            execution,
            pending: [],
            remaining: this.outputLimit,
            truncated: false,
            input: new vscode.CancellationTokenSource(),
            output: new OutputQueue(
                async () => {
                    const outputs = active.pending.splice(0).map((value) => {
                        const item =
                            value.type === 'plot'
                                ? new vscode.NotebookCellOutputItem(value.png, 'image/png')
                                : value.type === 'stdout'
                                  ? vscode.NotebookCellOutputItem.stdout(value.text)
                                  : vscode.NotebookCellOutputItem.stderr(value.text);
                        return new vscode.NotebookCellOutput([item]);
                    });
                    if (!this.closed && outputs.length) {
                        await execution.appendOutput(outputs);
                    }
                },
                (error) => {
                    active.outputError = error;
                },
            ),
        };
        this.current = active;
        execution.executionOrder = ++this.executionOrder;
        execution.start(Date.now());
        let success = false;
        try {
            await execution.clearOutput();
            const worker = this.getWorker();
            await worker.ready;
            if (this.closed) {
                return;
            }
            const outcome = await worker.console.execute(
                cell.document.getText(),
                this.lifetime.signal,
            );
            success = outcome === 'success';
            await active.output.flush();
            if (active.outputError) {
                throw active.outputError;
            }
        } catch (error) {
            await active.output.flush();
            if (!this.closed) {
                await execution.appendOutput(
                    new vscode.NotebookCellOutput([
                        vscode.NotebookCellOutputItem.error(
                            error instanceof Error ? error : new Error(String(error)),
                        ),
                    ]),
                );
            }
        } finally {
            active.output.dispose();
            active.input.cancel();
            active.input.dispose();
            if (this.current === active) {
                this.current = undefined;
                execution.end(success, Date.now());
            }
        }
    }

    private onEvent(event: WebRConsoleEvent): void {
        const active = this.current;
        if (!active || this.closed) {
            return;
        }
        if (event.type === 'input') {
            const session = this.worker?.console;
            void vscode.window
                .showInputBox({ prompt: event.prompt, ignoreFocusOut: true }, active.input.token)
                .then((value) => {
                    if (this.current === active && !this.closed) {
                        session?.replyInput(value ?? '');
                    }
                });
        } else if (event.type === 'plot') {
            active.pending.push(event);
            active.output.schedule('cell');
        } else if (event.type === 'stream' && !active.truncated) {
            const bytes = new TextEncoder().encode(event.text);
            let text = event.text;
            if (bytes.length > active.remaining) {
                text = new TextDecoder().decode(bytes.subarray(0, active.remaining), {
                    stream: true,
                });
                active.truncated = true;
            }
            active.remaining -= Math.min(bytes.length, active.remaining);
            const previous = active.pending.at(-1);
            if (previous?.type === event.channel) {
                previous.text += text;
            } else {
                active.pending.push({ type: event.channel, text });
            }
            if (active.truncated) {
                active.pending.push({ type: 'stderr', text: '\n[Console output truncated]\n' });
            }
            active.output.schedule('cell');
        }
    }

    async interrupt(restart: () => void): Promise<void> {
        if (!this.current) {
            return;
        }
        if (this.supportsInterrupt) {
            await this.worker?.console.interrupt();
        } else if (
            (await vscode.window.showWarningMessage(
                'This browser can stop the calculation by restarting webR. Restarting clears objects and imported files.',
                'Restart webR',
            )) === 'Restart webR' &&
            !this.closed
        ) {
            restart();
        }
    }

    dispose(): void {
        this.closed = true;
        if (this.current) {
            this.current.input.cancel();
            this.current.output.dispose();
            this.current.execution.end(false, Date.now());
            this.current = undefined;
        }
        this.lifetime.abort();
        this.worker?.console.close();
        this.worker = undefined;
    }
}
