
import * as cp from 'child_process';
import * as vscode from 'vscode';

import { getBrowserHtml } from '../session';
import { closeBrowser, isHost, shareBrowser } from '../liveshare';
import { config, doWithProgress, getRpath,  setContext } from '../util';
import { extensionContext } from '../extension';

class RMarkdownChild extends vscode.Disposable {
    title: string;
    cp: cp.ChildProcessWithoutNullStreams;
    panel: vscode.WebviewPanel;
    resourceViewColumn: vscode.ViewColumn;
    uri: vscode.Uri;
    externalUri: vscode.Uri;

    constructor(title: string, cp: cp.ChildProcessWithoutNullStreams, panel: vscode.WebviewPanel, resourceViewColumn: vscode.ViewColumn, uri: vscode.Uri, externalUri: vscode.Uri) {
        super(() => {
            this.cp.kill('SIGKILL');
            this.panel?.dispose();
        });

        this.title = title;
        this.cp = cp;
        this.panel = panel;
        this.resourceViewColumn = resourceViewColumn;
        this.uri = uri;
        this.externalUri = externalUri;
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
        const previewEngine: string = config().get('rmarkdown.previewEngine');
        const currentViewColumn: vscode.ViewColumn = vscode.window.activeTextEditor.viewColumn ?? vscode.ViewColumn.Active;
        const cmd = (
            `${this.rPath} --silent --slave --no-save --no-restore -e "${previewEngine}('${fileUri.path}')"`
        );
        const reg: RegExp = this.constructRegex(previewEngine);

        if (this.busyUriStore.has(fileUri)) {
            return;
        } else if (this.childStore.has(fileUri)) {
            this.childStore.get(fileUri).panel.reveal();
        } else {
            this.busyUriStore.add(fileUri);
            await doWithProgress(async (token: vscode.CancellationToken) => {
                await this.spawnProcess(cmd, reg, previewEngine, fileName, viewer, fileUri, currentViewColumn, token)
                    .catch((rejection: {
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
                    }
                    );
            },
                vscode.ProgressLocation.Notification,
                `Knitting ${fileName}...`,
                true
            );
            this.busyUriStore.delete(fileUri);
        }
    }

    public refreshPanel(): void {
        if (this.activePreview) {
            this.activePreview.panel.webview.html = '';
            this.activePreview.panel.webview.html = getBrowserHtml(this.activePreview.externalUri);
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
            void vscode.env.openExternal(this.activePreview.externalUri);
        }
    }

    private async showPreview(url: string, title: string, cp: cp.ChildProcessWithoutNullStreams, viewer: vscode.ViewColumn, fileUri: vscode.Uri, resourceViewColumn: vscode.ViewColumn): Promise<void> {
        // construct webview and its related html
        console.info(`[showPreview] uri: ${url}`);
        const uri = vscode.Uri.parse(url);
        const externalUri = await vscode.env.asExternalUri(uri);
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
            });
        panel.webview.html = getBrowserHtml(externalUri);

        // Push the new rmd webview to the open proccesses array,
        // to keep track of running child processes
        // (primarily used in killing the child process, but also
        // general state tracking)
        const childProcess = new RMarkdownChild(title, cp, panel, resourceViewColumn, fileUri, externalUri);
        this.childStore.add(childProcess);

        if (isHost()) {
            await shareBrowser(url, title);
        }

        // state change
        panel.onDidDispose(() => {
            // clear values
            this.activePreview === childProcess ? undefined : this.activePreview;
            void setContext('r.preview.active', false);
            this.childStore.delete(childProcess);

            if (isHost()) {
                closeBrowser(url);
            }
        });

        panel.onDidChangeViewState(({ webviewPanel }) => {
            void setContext('r.preview.active', webviewPanel.active);
            if (webviewPanel.active) {
                this.activePreview = childProcess;
            }
        });
    }

    private constructUrl(previewEngine: string, match: string, fileName?: string): string {
        switch (previewEngine) {
            case 'rmarkdown::run': {
                return `http://${match}/${fileName}`;
            }
            case 'xaringan::infinite_moon_reader': {
                return `http://${match}.html`;
            }
            default: {
                console.error(`[PreviewProvider] unsupported preview engine supplied as argument: ${previewEngine}`);
                break;
            }
        }
    }

    // construct a regex that is used in getting the path to the
    // *served* rmd file. this can differ depending on the
    // engine used, and can be expanded in the future.
    private constructRegex(previewEngine: string): RegExp {
        switch (previewEngine) {
            // the rmarkdown::run url is of the structure:
            // http://127.0.0.1:port/file.Rmd
            case 'rmarkdown::run': {
                return /(?<=http:\/\/)[0-9.:]*/g;
            }
            // the inf_mr output url is of the structure:
            // http://127.0.0.1:port/path/to/file.html
            case 'xaringan::infinite_moon_reader': {
                return /(?<=http:\/\/)(.*)(?=\.html)/g;
            }
            default: {
                console.error(`[PreviewProvider] unsupported preview engine supplied as argument: ${previewEngine}`);
                break;
            }
        }
    }

    // spawn a nodejs child process for knitting, and return the output's url for webview purposes
    private async spawnProcess(cmd: string, reg: RegExp, previewEngine: string, fileName: string, viewer: vscode.ViewColumn, fileUri: vscode.Uri, resourceViewColumn: vscode.ViewColumn, token: vscode.CancellationToken): Promise<cp.ChildProcessWithoutNullStreams> {
        return await new Promise<cp.ChildProcessWithoutNullStreams>((resolve, reject) => {
            let childProcess: cp.ChildProcessWithoutNullStreams;
            try {
                childProcess = cp.spawn(cmd, null, { shell: true });
            } catch (e: unknown) {
                console.warn(`[VSC-R] error: ${e as string}`);
                reject({ cp: childProcess, wasCancelled: false });
            }

            this.rMarkdownOutput.appendLine(`[VSC-R] ${fileName} process started`);

            // write the terminal output to R Markdown output stream
            // (mostly just knitting information)
            childProcess.stdout.on('data', (data: Buffer) => {
                this.rMarkdownOutput.appendLine(data.toString('utf8'));
            });

            childProcess.stderr.on('error', (e: Error) => {
                this.rMarkdownOutput.appendLine(`[VSC-R] knitting error: ${e.message}`);
                reject({ cp: childProcess, wasCancelled: false });
            });

            childProcess.on('exit', (code, signal) => {
                this.rMarkdownOutput.appendLine(`[VSC-R] ${fileName} process exited ` +
                    (signal ? `from signal '${signal}'` : `with exit code ${code}`));
            });

            childProcess.stderr.on('data',
                (data: Buffer) => {
                    const dat = data.toString('utf8');
                    this.rMarkdownOutput.appendLine(dat);
                    const match = reg.exec(dat)?.[0];
                    const previewUrl = this.constructUrl(previewEngine, match, fileName);
                    if (dat.includes('Execution halted')) {
                        reject({ cp: childProcess, wasCancelled: false });
                    } else if (match) {
                        void this.showPreview(previewUrl, fileName, childProcess, viewer, fileUri, resourceViewColumn);
                        resolve(childProcess);
                    }
                }
            );

            token.onCancellationRequested(() => {
                reject({cp: childProcess, wasCancelled: true});
            });
        });
    }
}
