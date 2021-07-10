
import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as cheerio from 'cheerio';

import path = require('path');
import crypto = require('crypto');


import { config, doWithProgress, getRpath, readContent, setContext, escapeHtml } from '../util';
import { extensionContext, tmpDir } from '../extension';

class RMarkdownPreview extends vscode.Disposable {
    title: string;
    cp: cp.ChildProcessWithoutNullStreams;
    panel: vscode.WebviewPanel;
    resourceViewColumn: vscode.ViewColumn;
    outputUri: vscode.Uri;
    htmlDarkContent: string;
    htmlLightContent: string;
    fileWatcher: fs.FSWatcher;
    autoRefresh: boolean;

    constructor(title: string, cp: cp.ChildProcessWithoutNullStreams, panel: vscode.WebviewPanel,
        resourceViewColumn: vscode.ViewColumn, outputUri: vscode.Uri, uri: vscode.Uri,
        RMarkdownPreviewManager: RMarkdownPreviewManager, useDarkTheme: boolean, autoRefresh: boolean) {
        super(() => {
            this.cp?.kill('SIGKILL');
            this.panel?.dispose();
            this.fileWatcher?.close();
            fs.removeSync(this.outputUri.fsPath);
        });

        this.title = title;
        this.cp = cp;
        this.panel = panel;
        this.resourceViewColumn = resourceViewColumn;
        this.outputUri = outputUri;
        this.autoRefresh = autoRefresh;
        void this.refreshContent(useDarkTheme);
        this.startFileWatcher(RMarkdownPreviewManager, uri);
    }

    public styleHtml(useDarkTheme: boolean) {
        if (useDarkTheme) {
            this.panel.webview.html = this.htmlDarkContent;
        } else {
            this.panel.webview.html = this.htmlLightContent;
        }
    }

    public async refreshContent(useDarkTheme: boolean) {
        this.getHtmlContent(await readContent(this.outputUri.fsPath, 'utf8'));
        this.styleHtml(useDarkTheme);
    }

    private startFileWatcher(RMarkdownPreviewManager: RMarkdownPreviewManager, uri: vscode.Uri) {
        let fsTimeout: NodeJS.Timeout;
        const fileWatcher = fs.watch(uri.fsPath, {}, () => {
            if (this.autoRefresh && !fsTimeout) {
                fsTimeout = setTimeout(() => { fsTimeout = null; }, 1000);
                void RMarkdownPreviewManager.updatePreview(this);
            }
        });
        this.fileWatcher = fileWatcher;
    }

    private getHtmlContent(htmlContent: string): void {
        let content = htmlContent.replace(/<(\w+)\s+(href|src)="(?!\w+:)/g,
            `<$1 $2="${String(this.panel.webview.asWebviewUri(vscode.Uri.file(tmpDir)))}/`);

        const re = new RegExp('<html[^\\n]*>.*</html>', 'ms');
        const isHtml = !!re.exec(content);

        if (!isHtml) {
            const html = escapeHtml(content);
            content = `<html><head></head><body><pre>${html}</pre></body></html>`;
        }

        this.htmlLightContent = content;


        const $ = cheerio.load(content);
        const chunkCol = String(config().get('rmarkdown.chunkBackgroundColor'));

        // make the output chunks a little lighter to stand out
        const colReg = /[0-9.]+/g;
        const regOut = chunkCol.match(colReg);
        const outCol = `rgba(${regOut[0] ?? 100}, ${regOut[1] ?? 100}, ${regOut[2] ?? 100}, ${Number(regOut[3]) + 0.05 ?? .5})`;

        const style =
            `<style>
            body {
                color: var(--vscode-editor-foreground);
                background: var(--vscode-editor-background);
            }
            .hljs {
                color: var(--vscode-editor-foreground);
            }
            code, pre {
                color: inherit;
                background: ${chunkCol};
                border-color: ${chunkCol};
            }
            pre:not([class]) {
                color: inherit;
                background: ${outCol};
            }
            pre > code {
                background: transparent;
            }
        </style>
        `;
        $('head').append(style);
        this.htmlDarkContent = $.html();
    }
}

class RMarkdownPreviewStore extends vscode.Disposable {
    private store: Map<vscode.Uri, RMarkdownPreview> = new Map<vscode.Uri, RMarkdownPreview>();

    constructor() {
        super((): void => {
            for (const preview of this.store) {
                preview[1].dispose();
            }
            this.store.clear();
        });
    }

    public add(uri: vscode.Uri, preview: RMarkdownPreview): Map<vscode.Uri, RMarkdownPreview> {
        return this.store.set(uri, preview);
    }

    // dispose child and remove it from set
    public delete(uri: vscode.Uri): boolean {
        this.store.get(uri).dispose();
        return this.store.delete(uri);
    }

    public get(uri: vscode.Uri): RMarkdownPreview {
        return this.store.get(uri);
    }

    public getUri(preview: RMarkdownPreview): vscode.Uri {
        for (const _preview of this.store) {
            if (_preview[1] === preview) {
                return _preview[0];
            }
        }
        return undefined;
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
    private activePreview: { uri: vscode.Uri, preview: RMarkdownPreview } = { uri: null, preview: null};
    // store of all open RMarkdown previews
    private previewStore: RMarkdownPreviewStore = new RMarkdownPreviewStore;
    // uri that are in the process of knitting
    // so that we can't spam the preview button
    private busyUriStore: Set<vscode.Uri> = new Set<vscode.Uri>();

    private useDarkTheme = true;

    public async init(): Promise<void> {
        this.rPath = await getRpath(true);
        extensionContext.subscriptions.push(this.previewStore);
    }

    public async previewRmd(viewer: vscode.ViewColumn, uri?: vscode.Uri): Promise<void> {
        const fileUri = uri ?? vscode.window.activeTextEditor.document.uri;
        const fileName = fileUri.fsPath.substring(fileUri.fsPath.lastIndexOf(path.sep) + 1);
        const currentViewColumn: vscode.ViewColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active ?? vscode.ViewColumn.One;
        if (this.busyUriStore.has(fileUri)) {
            return;
        } else if (this.previewStore.has(fileUri)) {
            this.previewStore.get(fileUri)?.panel.reveal();
        } else {
            this.busyUriStore.add(fileUri);
            await this.knitWithProgress(fileUri, fileName, viewer, currentViewColumn, uri);
            this.busyUriStore.delete(fileUri);
        }
    }

    public refreshPanel(preview?: RMarkdownPreview): void {
        if (preview) {
            void preview.refreshContent(this.useDarkTheme);
        } else if (this.activePreview) {
            void this.activePreview?.preview?.refreshContent(this.useDarkTheme);
        }
    }

    public enableAutoRefresh(preview?: RMarkdownPreview): void {
        if (preview) {
            preview.autoRefresh = true;
        } else if (this.activePreview?.preview) {
            this.activePreview.preview.autoRefresh = true;
            void setContext('r.preview.autoRefresh', true);
        }
    }

    public disableAutoRefresh(preview?: RMarkdownPreview): void {
        if (preview) {
            preview.autoRefresh = false;
        } else if (this.activePreview?.preview) {
            this.activePreview.preview.autoRefresh = false;
            void setContext('r.preview.autoRefresh', false);
        }
    }

    public toggleTheme(): void {
        this.useDarkTheme = !this.useDarkTheme;
        for (const preview of this.previewStore) {
            void preview[1].styleHtml(this.useDarkTheme);
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
            await vscode.commands.executeCommand('vscode.open', this.activePreview?.uri, {
                preserveFocus: false,
                preview: false,
                viewColumn: this.activePreview?.preview?.resourceViewColumn ?? this.activePreview?.preview?.panel.viewColumn ?? vscode.ViewColumn.Active
            });
        }
    }

    public async openExternalBrowser(): Promise<void> {
        if (this.activePreview) {
            await vscode.env.openExternal(this.activePreview?.preview?.outputUri);
        }
    }

    public async updatePreview(preview: RMarkdownPreview): Promise<void> {
        const previewUri = this.previewStore?.getUri(preview);
        preview.cp?.kill('SIGKILL');

        const childProcess: cp.ChildProcessWithoutNullStreams | void = await this.knitDocument(previewUri, preview.title).catch(() => {
            void vscode.window.showErrorMessage('There was an error in knitting the document. Please check the R Markdown output stream.');
            this.rMarkdownOutput.show(true);
            this.previewStore.delete(previewUri);
        });

        if (childProcess) {
            preview.cp = childProcess;
        }

        this.refreshPanel(preview);
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
            if (!rejection.wasCancelled) {
                void vscode.window.showErrorMessage('There was an error in knitting the document. Please check the R Markdown output stream.');
                this.rMarkdownOutput.show(true);
            }
            // this can occur when a successfuly knitted document is later altered (while still being previewed)
            // and subsequently fails to knit
            if (this.previewStore.has(uri)) {
                this.previewStore.delete(uri);
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
                `"cat('${lim}', rmarkdown::render('${String(fileUri.fsPath)}', output_format = rmarkdown::html_document(), output_file = '${outputFile}', intermediates_dir = '${tmpDir}'), '${lim}', sep='')"`
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
                    if (token?.isCancellationRequested) {
                        resolve(childProcess);
                    } else {
                        const outputUrl = re.exec(dat)?.[0]?.replace(re, '$1');
                        if (outputUrl) {
                            if (viewer !== undefined) {
                                const autoRefresh = config().get<boolean>('rmarkdown.preview.autoRefresh');
                                void this.openPreview(
                                    vscode.Uri.parse(outputUrl),
                                    fileUri,
                                    fileName,
                                    childProcess,
                                    viewer,
                                    currentViewColumn,
                                    autoRefresh
                                );
                            }
                            resolve(childProcess);
                        }
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

    private openPreview(outputUri: vscode.Uri, fileUri: vscode.Uri, title: string, cp: cp.ChildProcessWithoutNullStreams, viewer: vscode.ViewColumn, resourceViewColumn: vscode.ViewColumn, autoRefresh:boolean): void {
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

        // Push the new rmd webview to the open proccesses array,
        // to keep track of running child processes
        // (primarily used in killing the child process, but also
        // general state tracking)
        const preview = new RMarkdownPreview(
            title,
            cp,
            panel,
            resourceViewColumn,
            outputUri,
            fileUri,
            this,
            this.useDarkTheme,
            autoRefresh
        );
        this.previewStore.add(fileUri, preview);

        // state change
        panel.onDidDispose(() => {
            // clear values
            this.activePreview = this.activePreview?.preview === preview ? { uri: null, preview: null} : this.activePreview;
            void setContext('r.preview.active', false);
            this.previewStore.delete(fileUri);
        });

        panel.onDidChangeViewState(({ webviewPanel }) => {
            void setContext('r.preview.active', webviewPanel.active);
            if (webviewPanel.active) {
                this.activePreview.preview = preview;
                this.activePreview.uri = fileUri;
                void setContext('r.preview.autoRefresh', preview.autoRefresh);
            }
        });
    }
}

