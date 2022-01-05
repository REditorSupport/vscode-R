import path = require('path');
import * as vscode from 'vscode';
import * as vsls from 'vsls';

import { extensionContext, globalRHelp, rWorkspace } from '../extension';
import { config, readContent } from '../util';
import { showBrowser, showDataView, showWebView } from '../session';
import { liveSession, UUID, rGuestService, _sessionStatusBarItem as sessionStatusBarItem } from '.';
import { autoShareBrowser } from './shareTree';
import { docProvider, docScheme } from './virtualDocs';

// Workspace Vars
let guestPid: string;
export let guestGlobalenv: unknown;
export let guestResDir: string;
let rVer: string;
let info: IRequest['info'];

// Browser Vars
// Used to keep track of shared browsers
export const browserDisposables: { Disposable: vscode.Disposable, url: string, name: string }[] = [];

interface IRequest {
    command: string;
    time?: string;
    pid?: string;
    wd?: string;
    source?: string;
    type?: string;
    title?: string;
    file?: string;
    viewer?: string;
    plot?: string;
    action?: string;
    args?: unknown;
    sd?: string;
    url?: string;
    requestPath?: string;
    uuid?: number;
    tempdir?: string;
    version?: string;
    info?: {
        version: string,
        command: string,
        start_time: string
    };
}

export function initGuest(context: vscode.ExtensionContext): void {
    // create status bar item that contains info about the *guest* session watcher
    console.info('Create guestSessionStatusBarItem');
    const sessionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    sessionStatusBarItem.command = 'r.attachActiveGuest';
    sessionStatusBarItem.text = 'Guest R: (not attached)';
    sessionStatusBarItem.tooltip = 'Click to attach to host terminal';
    sessionStatusBarItem.show();
    context.subscriptions.push(
        sessionStatusBarItem,
        vscode.workspace.registerTextDocumentContentProvider(docScheme, docProvider)
    );
    rGuestService.setStatusBarItem(sessionStatusBarItem);
    guestResDir = path.join(context.extensionPath, 'dist', 'resources');
}

export function detachGuest(): void {
    console.info('[Guest Service] detach guest from workspace');
    sessionStatusBarItem.text = 'Guest R: (not attached)';
    sessionStatusBarItem.tooltip = 'Click to attach to host terminal';
    guestGlobalenv = undefined;
    rWorkspace?.refresh();
}

export function attachActiveGuest(): void {
    if (config().get<boolean>('sessionWatcher')) {
        console.info('[attachActiveGuest]');
        void rGuestService.requestAttach();
    } else {
        void vscode.window.showInformationMessage('This command requires that r.sessionWatcher be enabled.');
    }
}

// Guest version of session.ts updateRequest(), no need to check for changes in files
// as this is handled by the session.ts variant
// the force parameter is used for ensuring that the 'attach' case is appropriately called on guest join
export async function updateGuestRequest(file: string, force: boolean = false): Promise<void> {
    const requestContent: string = await readContent(file, 'utf8');
    console.info(`[updateGuestRequest] request: ${requestContent}`);
    if (typeof (requestContent) === 'string') {
        const request: IRequest = JSON.parse(requestContent) as IRequest;
        if (request && !force) {
            if (request.uuid === null || request.uuid === undefined || request.uuid === UUID) {
                switch (request.command) {
                    case 'help': {
                        if (globalRHelp) {
                            console.log(request.requestPath);
                            void globalRHelp.showHelpForPath(request.requestPath, request.viewer);
                        }
                        break;
                    }
                    case 'httpgd': {
                        break;
                    }
                    case 'attach': {
                        guestPid = String(request.pid);
                        console.info(`[updateGuestRequest] attach PID: ${guestPid}`);
                        sessionStatusBarItem.text = `Guest R ${rVer}: ${guestPid}`;
                        sessionStatusBarItem.tooltip = `${info.version}\nProcess ID: ${guestPid}\nCommand: ${info.command}\nStart time: ${info.start_time}\nClick to attach to host terminal.`;
                        break;
                    }
                    case 'browser': {
                        await showBrowser(request.url, request.title, request.viewer);
                        break;
                    }
                    case 'webview': {
                        void showWebView(request.file, request.title, request.viewer);
                        break;
                    }
                    case 'dataview': {
                        void showDataView(request.source,
                            request.type, request.title, request.file, request.viewer);
                        break;
                    }
                    case 'rstudioapi': {
                        console.error(`[GuestService] ${request.command} not supported`);
                        break;
                    }
                    default:
                        console.error(`[updateRequest] Unsupported command: ${request.command}`);
                }

            }
        } else {
            guestPid = String(request.pid);
            rVer = String(request.version);
            info = request.info;

            console.info(`[updateGuestRequest] attach PID: ${guestPid}`);
            sessionStatusBarItem.text = `Guest R ${rVer}: ${guestPid}`;
            sessionStatusBarItem.tooltip = `${info.version}\nProcess ID: ${guestPid}\nCommand: ${info.command}\nStart time: ${info.start_time}\nClick to attach to host terminal.`;
            sessionStatusBarItem.show();
        }
    }
}

// Call from host, pass parsed globalenvfile
export function updateGuestGlobalenv(hostEnv: string): void {
    if (hostEnv) {
        guestGlobalenv = hostEnv;
        void rWorkspace?.refresh();
        console.info('[updateGuestGlobalenv] Done');
    }
}

// Instead of creating a file, we pass the base64 of the plot image
// to the guest, and read that into an html page
let panel: vscode.WebviewPanel = undefined;
export async function updateGuestPlot(file: string): Promise<void> {
    const plotContent = await readContent(file, 'base64');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const guestPlotView: vscode.ViewColumn = vscode.ViewColumn[config().get<string>('session.viewers.viewColumn.plot')];
    if (plotContent) {
        if (panel) {
            panel.webview.html = getGuestImageHtml(plotContent);
            panel.reveal(guestPlotView, true);
        } else {
            panel = vscode.window.createWebviewPanel('dataview', 'R Guest Plot',
                {
                    preserveFocus: true,
                    viewColumn: guestPlotView,
                },
                {
                    enableScripts: true,
                    enableFindWidget: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [vscode.Uri.file(guestResDir)],
                });
            const content = getGuestImageHtml(plotContent);
            panel.webview.html = content;
            panel.onDidDispose(
                () => {
                    panel = undefined;
                },
                undefined,
                extensionContext.subscriptions
            );
        }
    }
}


// Purely used in order to decode a base64 string into
// an image format, bypassing saving a file onto the guest's system
function getGuestImageHtml(content: string) {
    return `
<!doctype HTML>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style type="text/css">
    body {
        color: black;
        background-color: var(--vscode-editor-background);
    }
    img {
        position: absolute;
        top:0;
        bottom: 0;
        left: 0;
        right: 0;
        margin: auto;
    }
  </style>
</head>
<body>
  <img src = "data:image/png;base64, ${String(content)}">
</body>
</html>
`;
}

// Share and close browser are called from the
// host session
// Automates sharing browser sessions through the
// shareServer method
export async function shareBrowser(url: string, name: string, force: boolean = false): Promise<void> {
    if (autoShareBrowser || force) {
        const _url = new URL(url);
        const server: vsls.Server = {
            port: parseInt(_url.port),
            displayName: name,
            browseUrl: url,
        };
        const disposable = await liveSession.shareServer(server);
        console.log(`[HostService] shared ${name} at ${url}`);
        browserDisposables.push({ Disposable: disposable, url, name });
    }
}

export function closeBrowser(url: string): void {
    browserDisposables.find(
        e => e.url === url
    )?.Disposable.dispose();

    for (const [key, item] of browserDisposables.entries()) {
        if (item.url === url) {
            browserDisposables.splice(key, 1);
        }
    }
}
