
import * as cp from 'child_process';
import * as kill from 'tree-kill';
import * as vscode from 'vscode';
import { getBrowserHtml } from '../session';
import { closeBrowser, isHost, shareBrowser } from '../liveshare';
import { config, doWithProgress, getRpath,  setContext } from '../util';

interface IPreviewProcess {
    cp: cp.ChildProcessWithoutNullStreams,
    file: string,
    panel: vscode.WebviewPanel,
}

export class RMarkdownPreviewManager {
    private openProcesses: IPreviewProcess[] = [];
    private activePreview: vscode.WebviewPanel;
    private activeResource: vscode.Uri;
    private activeExternalResource: vscode.Uri;
    private rPath: string;

    public async init(): Promise<void> {
        this.rPath = await getRpath(false);
    }

    public async previewRmd(viewer: vscode.ViewColumn, uri?: vscode.Uri): Promise<void> {
        const fileUri = uri ?? vscode.window.activeTextEditor.document.uri;
        const fileName = fileUri.path.substring(fileUri.path.lastIndexOf('/') + 1);
        const previewEngine: string = config().get('rmarkdown.previewEngine');
        const cmd = (
            `${this.rPath} --silent --slave --no-save --no-restore -e "${previewEngine}('${fileUri.path}')"`
        );
        const reg: RegExp = this.constructRegex(previewEngine);
        let call = undefined;


        if (this.openProcesses.some(e => e.file === fileName)) {
            this.openProcesses.filter(e => e.file === fileName)[0].panel.reveal();
        } else {
            await doWithProgress(() => {
                try {
                    call = cp.spawn(cmd, null, { shell: true });
                } catch (e) {
                    console.warn((e as string));
                }
                (call as cp.ChildProcessWithoutNullStreams).stderr.on('data',
                    (data: Buffer) => {
                        const dat = data.toString('utf8');
                        const match = reg.exec(dat)?.[0];
                        const previewUrl = this.constructUrl(previewEngine, match, fileName);
                        if (match) {
                            void this.showPreview(previewUrl, fileName, call, viewer, fileUri);
                        }
                    });
            },
                vscode.ProgressLocation.Notification,
                `Rendering ${fileName}...`
            );
        }
    }

    public refreshPanel(): void {
        if (this.activePreview) {
            this.activePreview.webview.html = '';
            this.activePreview.webview.html = getBrowserHtml(this.activeExternalResource);
        }
    }

    public async showSource(): Promise<void> {
        if (this.activeResource) {
            const viewCol = vscode.window.visibleTextEditors.filter(e => e.document.uri === this.activeResource)[0]?.viewColumn;
            await vscode.commands.executeCommand('vscode.open', this.activeResource, {
                preserveFocus: false,
                preview: false,
                viewColumn: viewCol ?? vscode.ViewColumn.Active
            });
        }
    }

    public openExternalBrowser(): void {
        if (this.activeExternalResource) {
            void vscode.env.openExternal(this.activeExternalResource);
        }
    }

    private async showPreview(url: string, title: string, cp: cp.ChildProcessWithoutNullStreams, viewer: vscode.ViewColumn, fileUri: vscode.Uri): Promise<void> {
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
        this.openProcesses.push(
            {
                cp: cp,
                file: title,
                panel: panel
            }
        );

        if (isHost()) {
            await shareBrowser(url, title);
        }

        // state change
        panel.onDidDispose(() => {
            // destroy process on closing window
            kill(cp.pid);

            void setContext('r.preview.active', false);
            for (const [key, item] of this.openProcesses.entries()) {
                if (item.file === title) {
                    this.openProcesses.splice(key, 1);
                }
            }

            if (isHost()) {
                closeBrowser(url);
            }
        });

        panel.onDidChangeViewState(({ webviewPanel }) => {
            void setContext('r.preview.active', webviewPanel.active);
            if (webviewPanel.active) {
                this.activePreview = webviewPanel;
                this.activeResource = fileUri;
                this.activeExternalResource = externalUri;
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
}
