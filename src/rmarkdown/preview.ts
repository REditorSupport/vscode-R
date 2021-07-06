
import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as fs from 'fs-extra';

import { doWithProgress, getRpath, readContent, setContext } from '../util';
import { extensionContext, tmpDir } from '../extension';
import path = require('path');
import crypto = require('crypto');

class RMarkdownChild extends vscode.Disposable {
    title: string;
    cp: cp.ChildProcessWithoutNullStreams;
    panel: vscode.WebviewPanel;
    resourceViewColumn: vscode.ViewColumn;
    uri: vscode.Uri;
    outputUri: vscode.Uri;
    dir: string;
    fileWatcher: fs.FSWatcher;

    constructor(title: string, cp: cp.ChildProcessWithoutNullStreams, panel: vscode.WebviewPanel, resourceViewColumn: vscode.ViewColumn, outputUri: vscode.Uri, uri: vscode.Uri, dir: string) {
        super(() => {
            this.cp?.kill('SIGKILL');
            this.panel?.dispose();
            this.fileWatcher?.close();
            fs.removeSync(this.outputUri.path);
        });

        this.title = title;
        this.cp = cp;
        this.panel = panel;
        this.resourceViewColumn = resourceViewColumn;
        this.uri = uri;
        this.outputUri = outputUri;
        this.dir = dir;
    }

    startFileWatcher(RMarkdownPreviewManager: RMarkdownPreviewManager) {
        let fsTimeout: NodeJS.Timeout;
        const docWatcher = fs.watch(this.uri.path, {}, () => {
            if (!fsTimeout) {
                fsTimeout = setTimeout(() => { fsTimeout = null; }, 1000);
                void RMarkdownPreviewManager.updatePreview(this);
            }
        });
        this.fileWatcher = docWatcher;
    }
}

class RMarkdownChildStore extends vscode.Disposable {
    private store: Set<RMarkdownChild> = new Set<RMarkdownChild>();

    constructor() {
        super((): void => {
            for (const child of this.store) {
                child.dispose();
            }
            this.store.clear();
        });
    }

    public add(child: RMarkdownChild): Set<RMarkdownChild> {
        return this.store.add(child);
    }

    // dispose child and remove it from set
    public delete(child: RMarkdownChild): boolean {
        child.dispose();
        return this.store.delete(child);
    }

    public get(uri: vscode.Uri): RMarkdownChild {
        for (const child of this.store) {
            if (child.uri === uri) {
                return child;
            }
        }
        return undefined;
    }

    public has(uri: vscode.Uri): boolean {
        for (const child of this.store) {
            if (child.uri === uri) {
                return true;
            }
        }
        return false;
    }

    [Symbol.iterator](): Iterator<RMarkdownChild> {
        return this.store[Symbol.iterator]();
    }
}

export class RMarkdownPreviewManager {
    private rPath: string;
    private rMarkdownOutput: vscode.OutputChannel = vscode.window.createOutputChannel('R Markdown');

    // the currently selected RMarkdown preview
    private activePreview: RMarkdownChild;
    // store of all open RMarkdown previews
    private childStore: RMarkdownChildStore = new RMarkdownChildStore;
    // uri that are in the process of knitting
    // so that we can't spam the preview button
    private busyUriStore: Set<vscode.Uri> = new Set<vscode.Uri>();

    public async init(): Promise<void> {
        this.rPath = await getRpath(false);
        extensionContext.subscriptions.push(this.childStore);
    }

    public async previewRmd(viewer: vscode.ViewColumn, uri?: vscode.Uri): Promise<void> {
        const fileUri = uri ?? vscode.window.activeTextEditor.document.uri;
        const fileName = fileUri.path.substring(fileUri.path.lastIndexOf('/') + 1);
        const currentViewColumn: vscode.ViewColumn = vscode.window.activeTextEditor.viewColumn ?? vscode.ViewColumn.Active;

        if (this.busyUriStore.has(fileUri)) {
            return;
        } else if (this.childStore.has(fileUri)) {
            this.childStore.get(fileUri).panel.reveal();
        } else {
           await this.retrieveSpawnData(fileUri, fileName, viewer, currentViewColumn, uri);
        }
    }


    public async refreshPanel(child?: RMarkdownChild): Promise<void> {
        if (child) {
            child.panel.webview.html = await this.loadHtml(child);
        } else if (this.activePreview) {
            this.activePreview.panel.webview.html = '';
            this.activePreview.panel.webview.html = await this.loadHtml(this.activePreview);
        }
    }

    // show the source uri for the current preview.
    // has a few idiosyncracies with view columns due to some limitations with
    // vscode api. the view column will be set in order of priority:
    //    1. the original document's view column when the preview button was pressed
    //    2. the current webview's view column
    //    3. the current active editor
    // this is because we cannot tell the view column of a file if it is not visible
    // (e.g., is an unopened tab)
    public async showSource(): Promise<void> {
        if (this.activePreview) {
            await vscode.commands.executeCommand('vscode.open', this.activePreview.uri, {
                preserveFocus: false,
                preview: false,
                viewColumn: this.activePreview.resourceViewColumn ?? this.activePreview.panel.viewColumn ?? vscode.ViewColumn.Active
            });
        }
    }

    public openExternalBrowser(): void {
        if (this.activePreview) {
            void vscode.env.openExternal(this.activePreview.outputUri);
        }
    }

    private async retrieveSpawnData(fileUri: vscode.Uri, fileName: string, viewer: vscode.ViewColumn, currentViewColumn: vscode.ViewColumn, uri?: vscode.Uri) {
        this.busyUriStore.add(fileUri);
        await doWithProgress(async (token: vscode.CancellationToken) => {
            await this.spawnProcess(fileUri, fileName, token, viewer, currentViewColumn);
        },
            vscode.ProgressLocation.Notification,
            `Knitting ${fileName}...`,
            true
        ).catch((rejection: {
            cp: cp.ChildProcessWithoutNullStreams,
            wasCancelled?: boolean
        }) => {
            if (!rejection.wasCancelled) {
                void vscode.window.showErrorMessage('There was an error in knitting the document. Please check the R Markdown output stream.');
                this.rMarkdownOutput.show(true);
            }
            // this can occur when a successfuly knitted document is later altered (while still being previewed)
            // and subsequently fails to knit
            if (this.childStore.has(uri)) {
                this.childStore.delete(this.childStore.get(uri));
            } else {
                rejection.cp.kill('SIGKILL');
            }
        });
        this.busyUriStore.delete(fileUri);
    }

    private async spawnProcess(fileUri: vscode.Uri, fileName: string, token?: vscode.CancellationToken, viewer?: vscode.ViewColumn, currentViewColumn?: vscode.ViewColumn) {
        return await new Promise<cp.ChildProcessWithoutNullStreams>((resolve, reject) => {
            const lim = '---vsc---';
            const re = new RegExp(`.*${lim}(.*)${lim}.*`, 'ms');
            const outputFile = path.join(tmpDir, crypto.createHash('sha256').update(fileUri.fsPath).digest('hex') + '.html');
            const cmd = (
                `${this.rPath} --silent --slave --no-save --no-restore -e ` +
                `"cat('${lim}', rmarkdown::render('${String(fileUri.path)}', output_file = '${outputFile}'), '${lim}', sep='')"`
            );

            let childProcess: cp.ChildProcessWithoutNullStreams;
            try {
                childProcess = cp.exec(cmd);
            } catch (e: unknown) {
                console.warn(`[VSC-R] error: ${e as string}`);
                reject({ cp: childProcess, wasCancelled: false });
            }

            this.rMarkdownOutput.appendLine(`[VSC-R] ${fileName} process started`);

            childProcess.stdout.on('data',
                (data: Buffer) => {
                    const dat = data.toString('utf8');
                    this.rMarkdownOutput.appendLine(dat);
                    const outputUrl = re.exec(dat)?.[0]?.replace(re, '$1');
                    if (outputUrl) {
                        if (viewer !== undefined) {
                            void this.openPreview(
                                vscode.Uri.parse(outputUrl),
                                fileUri,
                                fileName,
                                childProcess,
                                viewer,
                                currentViewColumn
                            );
                        }
                        resolve(childProcess);
                    }
                }
            );

            childProcess.stderr.on('data', (data: Buffer) => {
                const dat = data.toString('utf8');
                this.rMarkdownOutput.appendLine(dat);
                if (dat.includes('Execution halted')) {
                    reject({ cp: childProcess, wasCancelled: false });
                }
            });

            childProcess.on('exit', (code, signal) => {
                this.rMarkdownOutput.appendLine(`[VSC-R] ${fileName} process exited ` +
                    (signal ? `from signal '${signal}'` : `with exit code ${code}`));
            });

            token?.onCancellationRequested(() => {
                reject({ cp: childProcess, wasCancelled: true });
            });
        });
    }

    public async updatePreview(child: RMarkdownChild) {
        child.cp.kill('SIGKILL');

        const spawn: cp.ChildProcessWithoutNullStreams | void = await this.spawnProcess(child.uri, child.title).catch((rejection: {
            cp: cp.ChildProcessWithoutNullStreams,
            wasCancelled?: boolean
        }) => {
            void vscode.window.showErrorMessage('There was an error in knitting the document. Please check the R Markdown output stream.');
            this.rMarkdownOutput.show(true);
            rejection.cp.kill('SIGINT');
            this.childStore.get(child.uri).dispose();
        });

        if (spawn) {
            child.cp = spawn;
        }

        await this.refreshPanel(child);
    }

    private async openPreview(outputUri: vscode.Uri, fileUri: vscode.Uri, title: string, cp: cp.ChildProcessWithoutNullStreams, viewer: vscode.ViewColumn, resourceViewColumn: vscode.ViewColumn): Promise<void> {
        const dir = path.dirname(outputUri.path);
        const panel = vscode.window.createWebviewPanel(
            'previewRmd',
            `Preview ${title}`,
            {
                preserveFocus: true,
                viewColumn: viewer
            },
            {
                enableFindWidget: true,
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(dir)],
            });



        // Push the new rmd webview to the open proccesses array,
        // to keep track of running child processes
        // (primarily used in killing the child process, but also
        // general state tracking)
        const childProcess = new RMarkdownChild(
            title,
            cp,
            panel,
            resourceViewColumn,
            outputUri,
            fileUri,
            dir
        );
        this.childStore.add(childProcess);
        const html = await this.loadHtml(childProcess);
        panel.webview.html = html;
        childProcess.startFileWatcher(this);

        // state change
        panel.onDidDispose(() => {
            // clear values
            this.activePreview === childProcess ? undefined : this.activePreview;
            void setContext('r.preview.active', false);
            this.childStore.delete(childProcess);
        });

        panel.onDidChangeViewState(({ webviewPanel }) => {
            void setContext('r.preview.active', webviewPanel.active);
            if (webviewPanel.active) {
                this.activePreview = childProcess;
            }
        });
    }

    private async loadHtml(childProcess: RMarkdownChild): Promise<string> {
        const content = await readContent(childProcess.outputUri.path, 'utf8');
        const html = content.replace('<body>', '<body style="color: black;">')
            .replace(/<(\w+)\s+(href|src)="(?!\w+:)/g,
                `<$1 $2="${String(childProcess.panel.webview.asWebviewUri(vscode.Uri.file(childProcess.dir)))}/`);
        return html;
    }

}

