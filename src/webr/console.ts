import type { WebR } from 'webr';
import { consoleRunner } from './consoleRunner';

export type WebRConsoleResult = 'success' | 'error' | 'interrupted';

export type WebRConsoleEvent =
    | { type: 'stream'; channel: 'stdout' | 'stderr'; text: string }
    | { type: 'started' }
    | { type: 'input'; prompt: string }
    | { type: 'plot'; png: Uint8Array };

interface Cell {
    id: number;
    directory: string;
    phase: 'preparing' | 'submitted' | 'running' | 'input' | 'finishing' | 'fence';
    interrupted: boolean;
    outcome?: WebRConsoleResult;
    resolve(result: WebRConsoleResult): void;
    reject(error: Error): void;
}

const encoder = new TextEncoder();
const root = '/tmp/vscode-r-interactive';

/** One live R console. Each submitted program has its own source and graphics directory. */
export class WebRConsole {
    private active?: Cell;
    private sequence = 0;
    private closed = false;

    constructor(
        private readonly runtime: WebR,
        private readonly onEvent: (event: WebRConsoleEvent) => void,
        private readonly supportsInterrupt: boolean,
        private readonly onExit?: (error?: Error) => void,
    ) {}

    async start(): Promise<void> {
        await this.runtime.init();
        // Consume the startup banner and the initial prompt before accepting a cell.
        for (;;) {
            const message = await this.runtime.read();
            if (message.type === 'closed') {
                throw new Error('webR exited during startup.');
            }
            if (message.type === 'prompt') {
                break;
            }
        }
        await this.runtime.FS.mkdir(root);
        await this.runtime.evalRVoid(consoleRunner);
        void this.pump().catch((error) =>
            this.end(error instanceof Error ? error : new Error(String(error))),
        );
    }

    execute(
        code: string,
        signal?: AbortSignal,
        onSubmitted?: () => void,
    ): Promise<WebRConsoleResult> {
        if (this.closed || this.active) {
            return Promise.reject(
                new Error(this.closed ? 'webR session is closed.' : 'webR is busy.'),
            );
        }
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const cell: Cell = {
                id,
                directory: root + '/' + id,
                phase: 'preparing',
                interrupted: false,
                resolve,
                reject,
            };
            this.active = cell;
            void this.submit(cell, code, signal, onSubmitted).catch((error) => {
                if (this.active === cell) {
                    this.active = undefined;
                    reject(error);
                }
            });
        });
    }

    private async submit(
        cell: Cell,
        code: string,
        signal?: AbortSignal,
        onSubmitted?: () => void,
    ): Promise<void> {
        const directory = JSON.stringify(cell.directory);
        await this.runtime.FS.mkdir(cell.directory);
        try {
            await this.runtime.FS.writeFile(cell.directory + '/cell.R', encoder.encode(code));
            if (signal?.aborted || cell !== this.active) {
                throw new Error('webR submission cancelled before dispatch.');
            }
            if (cell.interrupted) {
                await this.runtime.FS.writeFile(cell.directory + '/cancel', new Uint8Array());
            }
            if (signal?.aborted || cell !== this.active) {
                throw new Error('webR submission cancelled before dispatch.');
            }
            this.runtime.writeConsole(
                'base::getOption("vscodeR.webR.execute")(' + directory + ', ' + cell.id + 'L)',
            );
            cell.phase = 'submitted';
            onSubmitted?.();
        } catch (error) {
            if (!this.closed) {
                await this.runtime
                    .evalRVoid('base::unlink(' + directory + ', recursive = TRUE)')
                    .catch(() => undefined);
            }
            throw error;
        }
    }

    replyInput(value: string): void {
        const cell = this.active;
        if (!cell || cell.phase !== 'input' || cell.interrupted) {
            throw new Error('webR is not waiting for input.');
        }
        cell.phase = 'running';
        this.runtime.writeConsole(value);
    }

    async interrupt(): Promise<void> {
        const cell = this.active;
        if (!cell || cell.outcome || cell.interrupted) {
            return;
        }
        if (!this.supportsInterrupt) {
            throw new Error('This webR communication channel does not support interruption.');
        }
        cell.interrupted = true;
        if (cell.phase === 'input') {
            // The worker is waiting for ReadConsole. A reply releases that wait; the
            // runner also sees cancellation before executing the next expression.
            await this.cancelInput(cell);
        } else if (cell.phase === 'running') {
            this.runtime.interrupt();
        }
        // An interrupt before the runner starts must not clear queued Wasm messages.
        // The started event delivers it once R has installed the interrupt handler.
    }

    private async cancelInput(cell: Cell): Promise<void> {
        await this.runtime.FS.writeFile(cell.directory + '/cancel', new Uint8Array());
        if (cell === this.active && cell.phase === 'input') {
            cell.phase = 'running';
            this.runtime.interrupt();
            this.runtime.writeConsole('');
        }
    }

    private async pump(): Promise<void> {
        while (!this.closed) {
            const message = await this.runtime.read();
            if (this.closed) {
                return;
            }
            const cell = this.active;
            switch (message.type) {
                case 'vscode-r-exit':
                case 'closed':
                    this.end();
                    return;
                case 'stdout':
                case 'stderr':
                    this.onEvent({
                        type: 'stream',
                        channel: message.type,
                        text: String(message.data) + '\n',
                    });
                    break;
                case 'vscode-r-stream-fragment': {
                    const fragment = message.data as { channel?: unknown; text?: unknown } | null;
                    if (
                        (fragment?.channel === 'stdout' || fragment?.channel === 'stderr') &&
                        typeof fragment.text === 'string'
                    ) {
                        this.onEvent({
                            type: 'stream',
                            channel: fragment.channel,
                            text: fragment.text,
                        });
                    }
                    break;
                }
                case 'vscode-r-execution': {
                    const marker = message.data as { id?: unknown; state?: unknown } | null;
                    if (!cell || marker?.id !== cell.id) {
                        break;
                    }
                    if (marker.state === 'started' && cell.phase === 'submitted') {
                        cell.phase = 'running';
                        if (cell.interrupted) {
                            this.runtime.interrupt();
                        }
                        this.onEvent({ type: 'started' });
                    } else if (
                        marker.state === 'success' ||
                        marker.state === 'error' ||
                        marker.state === 'interrupted'
                    ) {
                        cell.outcome = marker.state;
                    }
                    break;
                }
                case 'prompt':
                    if (cell && cell.phase !== 'preparing') {
                        await this.prompt(cell, String(message.data));
                    }
                    break;
            }
        }
    }

    private async prompt(cell: Cell, prompt: string): Promise<void> {
        if (cell.outcome) {
            if (cell.interrupted && cell.phase !== 'fence') {
                // A late interrupt may still be pending when a fast cell finishes.
                // Consume it before the next R call, including cleanup of this cell.
                cell.phase = 'fence';
                this.runtime.writeConsole(
                    'base::tryCatch(base::Sys.sleep(0), interrupt = function(e) NULL)',
                );
                return;
            }
            cell.phase = 'finishing';
            // A warning may arrive after the outcome marker. At this prompt the
            // preceding output is drained and the runner has closed its plots.
            try {
                const entries = await this.runtime.FS.lookupPath(cell.directory);
                for (const file of Object.keys(entries.contents ?? {}).sort()) {
                    if (/^plot-\d+-\d+\.png$/.test(file)) {
                        const png = await this.runtime.FS.readFile(cell.directory + '/' + file);
                        this.onEvent({ type: 'plot', png });
                    }
                }
            } finally {
                await this.runtime.evalRVoid(
                    'base::unlink(' + JSON.stringify(cell.directory) + ', recursive = TRUE)',
                );
            }
            this.active = undefined;
            cell.resolve(cell.outcome);
        } else if (cell.phase === 'submitted') {
            throw new Error('webR returned to the console before acknowledging the submission.');
        } else {
            cell.phase = 'input';
            if (cell.interrupted) {
                await this.cancelInput(cell);
            } else {
                this.onEvent({ type: 'input', prompt });
            }
        }
    }

    private end(error?: Error): void {
        if (this.closed) {
            return;
        }
        this.close(error);
        this.onExit?.(error);
    }

    close(error = new Error('webR session closed during execution.')): void {
        if (!this.closed) {
            this.closed = true;
            this.active?.reject(error);
            this.active = undefined;
            this.runtime.close();
        }
    }
}
