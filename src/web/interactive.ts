import * as vscode from 'vscode';
import { InteractiveSerializer } from '../interactive/notebook';
import { BrowserSession } from './session';
import { exportFile, importFiles } from './files';

const notebookType = 'r-interactive';

function openTabFor(uri: string): boolean {
    return vscode.window.tabGroups.all.some((group) =>
        group.tabs.some(
            (tab) =>
                tab.input instanceof vscode.TabInputNotebook && tab.input.uri.toString() === uri,
        ),
    );
}

export class BrowserInteractive implements vscode.Disposable {
    private readonly controller = vscode.notebooks.createNotebookController(
        'r-webr',
        notebookType,
        'R (webR)',
    );
    private readonly sessions = new Map<vscode.NotebookDocument, BrowserSession>();
    private readonly registrations: vscode.Disposable[];
    private last?: vscode.NotebookDocument;
    private opening?: Promise<vscode.NotebookDocument>;
    private disposed = false;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.controller.supportedLanguages = ['r'];
        this.controller.supportsExecutionOrder = true;
        this.controller.description = 'R in this browser';
        this.controller.executeHandler = async (cells, doc) => {
            const session = this.session(doc);
            await session.run(async () => {
                for (const cell of cells) {
                    if (!cell.document.isClosed) {
                        await session.evaluate(cell);
                    }
                }
            });
        };
        this.controller.interruptHandler = (doc) => this.interrupt(doc);
        const messages = vscode.notebooks.createRendererMessaging('r-interactive-renderer');
        this.registrations = [
            messages.onDidReceiveMessage(async ({ editor, message: raw }) => {
                const message = raw as Record<string, unknown> | undefined;
                if (
                    !message ||
                    typeof message !== 'object' ||
                    !['table', 'page', 'list', 'listPage', 'listNavigate', 'listItem'].includes(
                        String(message.action),
                    )
                ) {
                    return;
                }
                const session = this.sessions.get(editor.notebook);
                const reply = {
                    outputId: message.outputId,
                    action: message.action,
                    requestId: message.requestId,
                };
                try {
                    if (!session) {
                        throw new Error(
                            'This webR session has ended. Run the cell again for live controls.',
                        );
                    }
                    const result = await session.viewers.rendererMessage(message);
                    await messages.postMessage({ ...reply, result }, editor);
                } catch (error) {
                    await messages.postMessage({ ...reply, error: String(error) }, editor);
                }
            }),
            this.controller,
            vscode.workspace.registerNotebookSerializer(notebookType, new InteractiveSerializer(), {
                transientOutputs: false,
            }),
            vscode.window.onDidChangeActiveNotebookEditor((editor) => {
                if (editor?.notebook.notebookType === notebookType) {
                    this.last = editor.notebook;
                }
            }),
            vscode.workspace.onDidCloseNotebookDocument((doc) => this.forget(doc)),
            vscode.window.tabGroups.onDidChangeTabs((event) => {
                // The web workbench can cache a notebook model after its last tab
                // closes. Release its worker even when didCloseDocument is delayed.
                for (const tab of event.closed) {
                    if (
                        !(tab.input instanceof vscode.TabInputNotebook) ||
                        tab.input.notebookType !== notebookType
                    ) {
                        continue;
                    }
                    const uri = tab.input.uri.toString();
                    if (openTabFor(uri)) {
                        continue;
                    }
                    const doc = vscode.workspace.notebookDocuments.find(
                        (d) => d.uri.toString() === uri,
                    );
                    if (doc) {
                        this.forget(doc);
                    }
                }
            }),
        ];
    }

    private forget(doc: vscode.NotebookDocument): void {
        this.stop(doc);
        if (this.last === doc) {
            this.last = undefined;
        }
    }

    private target(): vscode.NotebookDocument | undefined {
        const active = vscode.window.activeNotebookEditor?.notebook;
        return active?.notebookType === notebookType
            ? active
            : (this.last ??
                  vscode.workspace.notebookDocuments.find(
                      (d) => d.notebookType === notebookType && openTabFor(d.uri.toString()),
                  ));
    }

    private session(doc: vscode.NotebookDocument): BrowserSession {
        if (this.disposed || doc.isClosed) {
            throw new Error('The R Interactive notebook is closed.');
        }
        let session = this.sessions.get(doc);
        if (!session) {
            session = new BrowserSession(this.controller, this.context.extensionUri, doc);
            this.sessions.set(doc, session);
        }
        return session;
    }

    private async reveal(doc: vscode.NotebookDocument, preserveFocus: boolean) {
        if (this.disposed || doc.isClosed) {
            throw new Error('The R Interactive notebook is closed.');
        }
        this.last = doc;
        this.controller.updateNotebookAffinity(doc, vscode.NotebookControllerAffinity.Preferred);
        const visible = vscode.window.visibleNotebookEditors.find(
            (editor) => editor.notebook === doc,
        );
        const editor =
            visible && preserveFocus
                ? visible
                : await vscode.window.showNotebookDocument(doc, {
                      viewColumn:
                          visible?.viewColumn ??
                          (preserveFocus ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active),
                      preserveFocus,
                  });
        await vscode.commands.executeCommand('notebook.selectKernel', {
            id: this.controller.id,
            extension: this.context.extension.id,
            notebookEditor: editor,
        });
        return doc;
    }

    open(create = false, preserveFocus = false): Promise<vscode.NotebookDocument> {
        if (this.opening) {
            return this.opening;
        }
        const target = create ? undefined : this.target();
        this.opening = (async () => {
            const doc =
                target ??
                (await vscode.workspace.openNotebookDocument(
                    notebookType,
                    new vscode.NotebookData([]),
                ));
            return this.reveal(doc, preserveFocus);
        })().finally(() => {
            this.opening = undefined;
        });
        return this.opening;
    }

    async submit(code: string): Promise<void> {
        if (!code.trim()) {
            return;
        }
        const doc = await this.open(false, true);
        const session = this.session(doc);
        await session.run(async () => {
            const index = doc.cellCount;
            const edit = new vscode.WorkspaceEdit();
            edit.set(doc.uri, [
                vscode.NotebookEdit.insertCells(index, [
                    new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, 'r'),
                ]),
            ]);
            if (!(await vscode.workspace.applyEdit(edit))) {
                throw new Error('Could not add code to the R Interactive notebook.');
            }
            // The user may edit or move cells while VS Code applies our edit.
            const cell = index < doc.cellCount ? doc.cellAt(index) : undefined;
            if (
                !cell ||
                cell.document.getText().replace(/\r\n/g, '\n') !== code.replace(/\r\n/g, '\n')
            ) {
                throw new Error('The submitted cell changed before it could run.');
            }
            await session.evaluate(cell);
        });
    }

    async import(uris?: readonly vscode.Uri[]): Promise<void> {
        const files =
            uris ??
            (await vscode.window.showOpenDialog({
                canSelectMany: true,
                openLabel: 'Import into webR',
                defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
            }));
        if (!files?.length) {
            return;
        }
        const doc = await this.open(false, true);
        await this.session(doc).files((runtime) => importFiles(runtime, files));
    }

    async export(source?: string, destination?: vscode.Uri): Promise<void> {
        const doc = this.target();
        if (!doc) {
            return;
        }
        const name =
            source ??
            (await vscode.window.showInputBox({
                prompt: 'File to export from the webR session directory',
                placeHolder: 'results/model.csv',
            }));
        if (!name) {
            return;
        }
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        const target =
            destination ??
            (await vscode.window.showSaveDialog({
                saveLabel: 'Export from webR',
                defaultUri: folder
                    ? vscode.Uri.joinPath(folder, name.split('/').at(-1) || 'output')
                    : undefined,
            }));
        if (target) {
            await this.session(doc).files((runtime) => exportFile(runtime, name, target));
        }
    }

    async interrupt(doc = this.target()): Promise<void> {
        if (doc) {
            await this.sessions.get(doc)?.interrupt(() => this.stop(doc));
        }
    }

    stop(doc = this.target()): void {
        if (!doc) {
            return;
        }
        this.sessions.get(doc)?.dispose();
        this.sessions.delete(doc);
    }

    stopAll(): void {
        for (const doc of this.sessions.keys()) {
            this.stop(doc);
        }
    }

    async actions(): Promise<void> {
        const actions = [
            { label: 'Import files into webR…', run: () => this.import() },
            { label: 'Export a file from webR…', run: () => this.export() },
            { label: 'Interrupt calculation', run: () => this.interrupt() },
            { label: 'Restart webR session', run: () => this.stop() },
        ];
        const selected = await vscode.window.showQuickPick(actions, {
            title: 'R Interactive (webR)',
        });
        await Promise.resolve(selected?.run());
    }

    dispose(): void {
        this.disposed = true;
        this.stopAll();
        for (const entry of this.registrations) {
            entry.dispose();
        }
    }
}
