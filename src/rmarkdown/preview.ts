
import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as fs from 'fs-extra';

import { config, doWithProgress, getRpath, readContent, setContext } from '../util';
import { extensionContext, tmpDir } from '../extension';
import path = require('path');
import crypto = require('crypto');

class RMarkdownChild extends vscode.Disposable {
    title: string;
    cp: cp.ChildProcessWithoutNullStreams;
    panel: vscode.WebviewPanel;
    resourceViewColumn: vscode.ViewColumn;
    // todo, restructure, as uri is now used as a key
    uri: vscode.Uri
    outputUri: vscode.Uri;
    htmlContent: string;
    fileWatcher: fs.FSWatcher;

    constructor(title: string, cp: cp.ChildProcessWithoutNullStreams, panel: vscode.WebviewPanel, resourceViewColumn: vscode.ViewColumn, outputUri: vscode.Uri, uri: vscode.Uri, htmlContent: string, RMarkdownPreviewManager: RMarkdownPreviewManager) {
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
        this.htmlContent = htmlContent;
        this.startFileWatcher(RMarkdownPreviewManager);
    }

    private startFileWatcher(RMarkdownPreviewManager: RMarkdownPreviewManager) {
        let fsTimeout: NodeJS.Timeout;
        const fileWatcher = fs.watch(this.uri.path, {}, () => {
            if (!fsTimeout) {
                fsTimeout = setTimeout(() => { fsTimeout = null; }, 1000);
                void RMarkdownPreviewManager.updatePreview(this);
            }
        });
        this.fileWatcher = fileWatcher;
    }
}

class RMarkdownChildStore extends vscode.Disposable {
    private store: Map<vscode.Uri, RMarkdownChild> = new Map<vscode.Uri, RMarkdownChild>();

    constructor() {
        super((): void => {
            for (const child of this.store) {
                child[1].dispose();
            }
            this.store.clear();
        });
    }

    public add(uri:vscode.Uri, child: RMarkdownChild): Map<vscode.Uri, RMarkdownChild> {
        return this.store.set(uri, child);
    }

    // dispose child and remove it from set
    public delete(uri: vscode.Uri): boolean {
        this.store.get(uri).dispose();
        return this.store.delete(uri);
    }

    public get(uri: vscode.Uri): RMarkdownChild {
        return this.store.get(uri);
    }

    public has(uri: vscode.Uri): boolean {
        return this.store.has(uri);
    }

    [Symbol.iterator]() {
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

    // todo, better name? enum?
    private vscodeTheme = true;

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
            this.childStore.get(fileUri)?.panel.reveal();
        } else {
            this.busyUriStore.add(fileUri);
            await this.knitWithProgress(fileUri, fileName, viewer, currentViewColumn, uri);
            this.busyUriStore.delete(fileUri);
        }
    }

    // todo, should this trigger a re-knit?
    public refreshPanel(child?: RMarkdownChild): void {
        if (child) {
            child.panel.webview.html = this.getHtmlContent(child);
        } else if (this.activePreview) {
            this.activePreview.panel.webview.html = '';
            this.activePreview.panel.webview.html = this.getHtmlContent(this.activePreview);
        }
    }

    public toggleTheme(): void {
        this.vscodeTheme = !this.vscodeTheme;
        for (const child of this.childStore) {
            this.refreshPanel(child[1]);
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
            void vscode.env.openExternal(
                this.activePreview.outputUri
            );
        }
    }

    private async knitWithProgress(fileUri: vscode.Uri, fileName: string, viewer: vscode.ViewColumn, currentViewColumn: vscode.ViewColumn, uri?: vscode.Uri) {
        await doWithProgress(async (token: vscode.CancellationToken) => {
            await this.knitDocument(fileUri, fileName, token, viewer, currentViewColumn);
        },
            vscode.ProgressLocation.Notification,
            `Knitting ${fileName}...`,
            true
        ).catch((rejection: {
            cp: cp.ChildProcessWithoutNullStreams,
            wasCancelled?: boolean
        }) => {
            // todo, this section may need to be cleaned up a bit,
            // move the non-rejection catch to the await knitDocument?
            if (!rejection.wasCancelled) {
                void vscode.window.showErrorMessage('There was an error in knitting the document. Please check the R Markdown output stream.');
                this.rMarkdownOutput.show(true);
            }
            // this can occur when a successfuly knitted document is later altered (while still being previewed)
            // and subsequently fails to knit
            if (this.childStore.has(uri)) {
                this.childStore.delete(uri);
            } else {
                rejection.cp.kill('SIGKILL');
            }
        });
    }

    private async knitDocument(fileUri: vscode.Uri, fileName: string, token?: vscode.CancellationToken, viewer?: vscode.ViewColumn, currentViewColumn?: vscode.ViewColumn) {
        return await new Promise<cp.ChildProcessWithoutNullStreams>((resolve, reject) => {
            const lim = '---vsc---';
            const re = new RegExp(`.*${lim}(.*)${lim}.*`, 'ms');
            const outputFile = path.join(tmpDir, crypto.createHash('sha256').update(fileUri.fsPath).digest('hex') + '.html');
            const cmd = (
                `${this.rPath} --silent --slave --no-save --no-restore -e ` +
                `"cat('${lim}',
                rmarkdown::render('${String(fileUri.path)}', output_format = rmarkdown::html_document(), output_file = '${outputFile}'),
                '${lim}', sep='')"`
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

    public async updatePreview(child: RMarkdownChild): Promise<void> {
        child.cp?.kill('SIGKILL');

        const childProcess: cp.ChildProcessWithoutNullStreams | void = await this.knitDocument(child.uri, child.title).catch((rejection: {
            cp: cp.ChildProcessWithoutNullStreams,
            wasCancelled?: boolean
        }) => {
            void vscode.window.showErrorMessage('There was an error in knitting the document. Please check the R Markdown output stream.');
            this.rMarkdownOutput.show(true);
            rejection.cp.kill('SIGINT');
            this.childStore.get(child.uri)?.dispose();
        });

        if (childProcess) {
            child.cp = childProcess;
        }

        this.refreshPanel(child);
    }

    private async openPreview(outputUri: vscode.Uri, fileUri: vscode.Uri, title: string, cp: cp.ChildProcessWithoutNullStreams, viewer: vscode.ViewColumn, resourceViewColumn: vscode.ViewColumn): Promise<void> {
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
                localResourceRoots: [vscode.Uri.file(tmpDir)],
            });
        const htmlContent = await readContent(outputUri.path, 'utf8');

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
            htmlContent,
            this
        );
        this.childStore.add(fileUri, childProcess);

        panel.webview.html = this.getHtmlContent(childProcess);

        // state change
        panel.onDidDispose(() => {
            // clear values
            this.activePreview === childProcess ? undefined : this.activePreview;
            void setContext('r.preview.active', false);
            this.childStore.delete(fileUri);
        });

        panel.onDidChangeViewState(({ webviewPanel }) => {
            void setContext('r.preview.active', webviewPanel.active);
            if (webviewPanel.active) {
                this.activePreview = childProcess;
            }
        });
    }

    private getHtmlContent(childProcess: RMarkdownChild): string {
        if (!this.vscodeTheme) {
            return childProcess.htmlContent.replace(/<(\w+)\s+(href|src)="(?!\w+:)/g,
                `<$1 $2="${String(childProcess.panel.webview.asWebviewUri(vscode.Uri.file(tmpDir)))}/`);
        } else {
            // todo, potentially emulate vscode syntax highlighting?
            const style =
                `<style>
            body {
                color: var(--vscode-editor-foreground);
                background: var(--vscode-editor-background);
            }
            .r {
                color: inherit;
                background: ${String(config().get('rmarkdown.chunkBackgroundColor'))};
                border-color: ${String(config().get('rmarkdown.chunkBackgroundColor'))};
            }
            .hljs {
                color: var(--vscode-editor-foreground);
            }
        </style>
        `;
            const headerReg = /(?<=<head>)[\s\S]*(?=<\/head>)/g;
            const header = headerReg.exec(childProcess.htmlContent)?.[0];
            const html = childProcess.htmlContent
                .replace(header, header + style)
                .replace(/<(\w+)\s+(href|src)="(?!\w+:)/g,
                    `<$1 $2="${String(childProcess.panel.webview.asWebviewUri(vscode.Uri.file(tmpDir)))}/`);
            return html;
        }
    }
}

