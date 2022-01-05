import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as cheerio from 'cheerio';

import path = require('path');
import crypto = require('crypto');


import { config, readContent, setContext, escapeHtml, UriIcon, saveDocument, getRpath, DisposableProcess } from '../util';
import { extensionContext, tmpDir } from '../extension';
import { knitDir } from './knit';
import { RMarkdownManager } from './manager';

class RMarkdownPreview extends vscode.Disposable {
    title: string;
    cp: DisposableProcess;
    panel: vscode.WebviewPanel;
    resourceViewColumn: vscode.ViewColumn;
    outputUri: vscode.Uri;
    htmlDarkContent: string;
    htmlLightContent: string;
    fileWatcher: fs.FSWatcher;
    autoRefresh: boolean;
    mtime: number;

    constructor(title: string, cp: DisposableProcess, panel: vscode.WebviewPanel,
        resourceViewColumn: vscode.ViewColumn, outputUri: vscode.Uri, filePath: string,
        RMarkdownPreviewManager: RMarkdownPreviewManager, useCodeTheme: boolean, autoRefresh: boolean) {
        super(() => {
            this.cp?.dispose();
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
        this.mtime = fs.statSync(filePath).mtime.getTime();
        void this.refreshContent(useCodeTheme);
        this.startFileWatcher(RMarkdownPreviewManager, filePath);
    }

    public styleHtml(useCodeTheme: boolean) {
        if (useCodeTheme) {
            this.panel.webview.html = this.htmlDarkContent;
        } else {
            this.panel.webview.html = this.htmlLightContent;
        }
    }

    public async refreshContent(useCodeTheme: boolean) {
        this.getHtmlContent(await readContent(this.outputUri.fsPath, 'utf8'));
        this.styleHtml(useCodeTheme);
    }

    private startFileWatcher(RMarkdownPreviewManager: RMarkdownPreviewManager, filePath: string) {
        let fsTimeout: NodeJS.Timeout;
        const fileWatcher = fs.watch(filePath, {}, () => {
            const mtime = fs.statSync(filePath).mtime.getTime();
            if (this.autoRefresh && !fsTimeout && mtime !== this.mtime) {
                fsTimeout = setTimeout(() => { fsTimeout = null; }, 1000);
                this.mtime = mtime;
                void RMarkdownPreviewManager.updatePreview(this);
            }
        });
        this.fileWatcher = fileWatcher;
    }

    private getHtmlContent(htmlContent: string): void {
        let content = htmlContent.replace(/<(\w+)\s+(href|src)="(?!(\w+:)|#)/g,
            `<$1 $2="${String(this.panel.webview.asWebviewUri(vscode.Uri.file(tmpDir())))}/`);

        const re = new RegExp('<html[^\\n]*>.*</html>', 'ms');
        const isHtml = !!re.exec(content);

        if (!isHtml) {
            const html = escapeHtml(content);
            content = `<html><head></head><body><pre>${html}</pre></body></html>`;
        }

        const $ = cheerio.load(content);
        this.htmlLightContent = $.html();

        // make the output chunks a little lighter to stand out
        let chunkCol = String(config().get('rmarkdown.chunkBackgroundColor'));
        let outCol: string;
        if (chunkCol) {
            const colReg = /[0-9.]+/g;
            const regOut = chunkCol.match(colReg);
            outCol = `rgba(${regOut[0] ?? 128}, ${regOut[1] ?? 128}, ${regOut[2] ?? 128}, ${Math.max(0, Number(regOut[3] ?? 0.1) - 0.05)})`;
        } else {
            chunkCol = 'rgba(128, 128, 128, 0.1)';
            outCol = 'rgba(128, 128, 128, 0.05)';
        }

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
            h1, h2, h3, h4, h5, h6, .h1, .h2, .h3, .h4, .h5, .h6 {
                color: inherit;
            }
        </style>
        `;
        $('head').append(style);
        this.htmlDarkContent = $.html();
    }
}

class RMarkdownPreviewStore extends vscode.Disposable {
    private store: Map<string, RMarkdownPreview> = new Map<string, RMarkdownPreview>();

    constructor() {
        super((): void => {
            for (const preview of this.store) {
                preview[1].dispose();
            }
            this.store.clear();
        });
    }

    public add(filePath: string, preview: RMarkdownPreview): Map<string, RMarkdownPreview> {
        return this.store.set(filePath, preview);
    }

    // dispose child and remove it from set
    public delete(filePath: string): boolean {
        this.store.get(filePath).dispose();
        return this.store.delete(filePath);
    }

    public get(filePath: string): RMarkdownPreview {
        return this.store.get(filePath);
    }

    public getFilePath(preview: RMarkdownPreview): string {
        for (const _preview of this.store) {
            if (_preview[1] === preview) {
                return _preview[0];
            }
        }
        return undefined;
    }

    public has(filePath: string): boolean {
        return this.store.has(filePath);
    }

    [Symbol.iterator]() {
        return this.store[Symbol.iterator]();
    }
}

export class RMarkdownPreviewManager extends RMarkdownManager {
    // the currently selected RMarkdown preview
    private activePreview: { filePath: string, preview: RMarkdownPreview, title: string } = { filePath: null, preview: null, title: null };
    // store of all open RMarkdown previews
    private previewStore: RMarkdownPreviewStore = new RMarkdownPreviewStore;
    private useCodeTheme = true;

    constructor() {
        super();
        extensionContext.subscriptions.push(this.previewStore);
    }


    public async previewRmd(viewer: vscode.ViewColumn, uri?: vscode.Uri): Promise<void> {
        const filePath = uri ? uri.fsPath : vscode.window.activeTextEditor.document.uri.fsPath;
        const fileName = path.basename(filePath);
        const currentViewColumn: vscode.ViewColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active ?? vscode.ViewColumn.One;

        // handle untitled rmd files
        if (!uri && vscode.window.activeTextEditor.document.isUntitled) {
            void vscode.window.showWarningMessage('Cannot knit an untitled file. Please save the document.');
            await vscode.commands.executeCommand('workbench.action.files.save').then(() => {
                if (!vscode.window.activeTextEditor.document.isUntitled) {
                    void this.previewRmd(viewer);
                }
            });
            return;
        }

        const isSaved = uri ?
            true :
            await saveDocument(vscode.window.activeTextEditor.document);

        if (isSaved) {
            // don't knit if the current uri is already being knit
            if (this.busyUriStore.has(filePath)) {
                return;
            } else if (this.previewStore.has(filePath)) {
                this.previewStore.get(filePath)?.panel.reveal();
            } else {
                this.busyUriStore.add(filePath);
                await this.previewDocument(filePath, fileName, viewer, currentViewColumn);
                this.busyUriStore.delete(filePath);
            }
        }
    }

    public enableAutoRefresh(preview?: RMarkdownPreview): void {
        if (preview) {
            preview.autoRefresh = true;
        } else if (this.activePreview?.preview) {
            this.activePreview.preview.autoRefresh = true;
            void setContext('r.rmarkdown.preview.autoRefresh', true);
        }
    }

    public disableAutoRefresh(preview?: RMarkdownPreview): void {
        if (preview) {
            preview.autoRefresh = false;
        } else if (this.activePreview?.preview) {
            this.activePreview.preview.autoRefresh = false;
            void setContext('r.rmarkdown.preview.autoRefresh', false);
        }
    }

    public toggleTheme(): void {
        this.useCodeTheme = !this.useCodeTheme;
        for (const preview of this.previewStore) {
            void preview[1].styleHtml(this.useCodeTheme);
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
        if (this.activePreview?.filePath) {
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(this.activePreview.filePath), {
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

    public async updatePreview(preview?: RMarkdownPreview): Promise<void> {
        const toUpdate = preview ?? this.activePreview?.preview;
        const previewUri = this.previewStore?.getFilePath(toUpdate);
        toUpdate?.cp?.dispose();

        if (toUpdate) {
            const childProcess: DisposableProcess | void = await this.previewDocument(previewUri, toUpdate.title).catch(() => {
                void vscode.window.showErrorMessage('There was an error in knitting the document. Please check the R Markdown output stream.');
                this.rMarkdownOutput.show(true);
                this.previewStore.delete(previewUri);
            });

            if (childProcess) {
                toUpdate.cp = childProcess;
            }

            this.refreshPanel(toUpdate);
        }

    }

    private async previewDocument(filePath: string, fileName?: string, viewer?: vscode.ViewColumn, currentViewColumn?: vscode.ViewColumn): Promise<DisposableProcess> {
        const knitWorkingDir = this.getKnitDir(knitDir, filePath);
        const knitWorkingDirText = knitWorkingDir ? `${knitWorkingDir}` : '';
        this.rPath = await getRpath();

        const lim = '<<<vsc>>>';
        const re = new RegExp(`.*${lim}(.*)${lim}.*`, 'ms');
        const outputFile = path.join(tmpDir(), crypto.createHash('sha256').update(filePath).digest('hex') + '.html');
        const scriptValues = {
            'VSCR_KNIT_DIR': knitWorkingDirText,
            'VSCR_LIM': lim,
            'VSCR_FILE_PATH': filePath.replace(/\\/g, '/'),
            'VSCR_OUTPUT_FILE': outputFile.replace(/\\/g, '/'),
            'VSCR_TMP_DIR': tmpDir().replace(/\\/g, '/')
        };


        const callback = (dat: string, childProcess: DisposableProcess) => {
            const outputUrl = re.exec(dat)?.[0]?.replace(re, '$1');
            if (outputUrl) {
                if (viewer !== undefined) {
                    const autoRefresh = config().get<boolean>('rmarkdown.preview.autoRefresh');
                    void this.openPreview(
                        vscode.Uri.file(outputUrl),
                        filePath,
                        fileName,
                        childProcess,
                        viewer,
                        currentViewColumn,
                        autoRefresh
                    );
                }
                return true;
            }
            return false;
        };

        const onRejected = (filePath: string) => {
            if (this.previewStore.has(filePath)) {
                this.previewStore.delete(filePath);
            }
        };

        return await this.knitWithProgress(
            {
                workingDirectory: knitWorkingDir,
                fileName: fileName,
                filePath: filePath,
                scriptPath: extensionContext.asAbsolutePath('R/rmarkdown/preview.R'),
                scriptArgs: scriptValues,
                rOutputFormat: 'html preview',
                callback: callback,
                onRejection: onRejected
            }
        );
    }

    private openPreview(outputUri: vscode.Uri, filePath: string, title: string, cp: DisposableProcess, viewer: vscode.ViewColumn, resourceViewColumn: vscode.ViewColumn, autoRefresh: boolean): void {

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
                localResourceRoots: [vscode.Uri.file(tmpDir())],
            });

        panel.iconPath = new UriIcon('preview');

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
            filePath,
            this,
            this.useCodeTheme,
            autoRefresh
        );
        this.previewStore.add(filePath, preview);

        // state change
        panel.onDidDispose(() => {
            // clear values
            this.activePreview = this.activePreview?.preview === preview ? { filePath: null, preview: null, title: null } : this.activePreview;
            void setContext('r.rmarkdown.preview.active', false);
            this.previewStore.delete(filePath);
        });

        panel.onDidChangeViewState(({ webviewPanel }) => {
            void setContext('r.rmarkdown.preview.active', webviewPanel.active);
            if (webviewPanel.active) {
                this.activePreview.preview = preview;
                this.activePreview.filePath = filePath;
                this.activePreview.title = title;
                void setContext('r.rmarkdown.preview.autoRefresh', preview.autoRefresh);
            }
        });
    }

    private refreshPanel(preview: RMarkdownPreview): void {
        void preview.refreshContent(this.useCodeTheme);
    }
}

