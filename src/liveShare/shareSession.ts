import path = require('path');
import * as vscode from 'vscode';

import { extensionContext, globalPlotManager, globalRHelp, rWorkspace } from '../extension';
import { asViewColumn, config, readContent } from '../util';
import { showBrowser, showDataView, WorkspaceData } from '../session';
import { showWebView } from '../webViewer';
import { liveSession, UUID, rGuestService, _sessionStatusBarItem as sessionStatusBarItem, isGuest, guestResDir } from '.';
import { autoShareBrowser } from './shareTree';
import { docProvider, docScheme } from './virtualDocs';

// Workspace Vars
let guestPid: string;
export let guestWorkspace: WorkspaceData | undefined;
let rVer: string;
let info: IRequest['info'];

// Browser Vars
// Used to keep track of shared browsers
export const browserDisposables: { Disposable: vscode.Disposable, url: string, name: string }[] = [];

export interface IRequest {
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



export function detachGuest(): void {
    console.info('[Guest Service] detach guest from workspace');
    sessionStatusBarItem.text = 'Guest R: (not attached)';
    sessionStatusBarItem.tooltip = 'Click to activate host R session';
    guestWorkspace = undefined;
    rWorkspace?.refresh();
}



// Guest version of session.ts updateRequest(), no need to check for changes in files
// as this is handled by the session.ts variant
// the force parameter is used for ensuring that the 'attach' case is appropriately called on guest join
export async function updateGuestRequest(file: string, force: boolean = false): Promise<void> {
    const requestContent: string | undefined = await rGuestService?.requestFileContent(file, 'utf8');
    if (!requestContent) {
        return;
    }
    console.info(`[updateGuestRequest] request: ${requestContent}`);
    if (typeof (requestContent) !== 'string') {
        return;
    }

    const request: IRequest = JSON.parse(requestContent) as IRequest;
    if (!request) {
        return;
    }

    if (force) {
        // The last request is not necessarily an attach request.
        guestPid = String(request.pid);
        console.info(`[updateGuestRequest] attach PID: ${guestPid}`);
        sessionStatusBarItem.text = `Guest R: ${guestPid}`;
        sessionStatusBarItem.tooltip = 'Click to activate host R session';
        sessionStatusBarItem.show();
    }

    if (request.uuid === null || request.uuid === undefined || request.uuid === UUID) {
        switch (request.command) {
            case 'help': {
                if (globalRHelp) {
                    console.log(request.requestPath);
                    if (request.requestPath) {
                        await globalRHelp.showHelpForPath(request.requestPath, request.viewer);
                    }
                }
                break;
            }
            case 'httpgd': {
                if (request.url) {
                    await globalPlotManager?.showHttpgdPlot(request.url);
                }
                break;
            }
            case 'attach': {
                guestPid = String(request.pid);
                rVer = String(request.version);
                info = request.info;
                console.info(`[updateGuestRequest] attach PID: ${guestPid}`);
                sessionStatusBarItem.text = `Guest R ${rVer}: ${guestPid}`;
                // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
                sessionStatusBarItem.tooltip = `${info?.version || 'unknown version'}\nProcess ID: ${guestPid}\nCommand: ${info?.command}\nStart time: ${info?.start_time}\nClick to activate host R session`;
                sessionStatusBarItem.show();
                break;
            }
            case 'browser':
            case 'page_viewer':
            case 'webview': {
                if (request.url) {
                    const url = String(request.url);
                    const title = String(request.title ?? (request.command === 'browser' ? 'Browser' : request.command === 'page_viewer' ? 'Page Viewer' : 'Viewer'));

                    const viewColumnConfig = config().get<Record<string, string>>('session.viewers.viewColumn') ?? {};
                    const configKey = request.command === 'page_viewer' ? 'pageViewer' : (request.command === 'browser' ? 'browser' : 'viewer');
                    const viewerChoice = viewColumnConfig[configKey] ?? 'Active';
                    const viewColumn = viewerChoice === 'Disable' ? false : viewerChoice;

                    if (url.startsWith('http://') || url.startsWith('https://')) {
                        const isLocalHost = url.match(/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i);
                        if (isLocalHost) {
                            const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(url));
                            await showBrowser(externalUri.toString(true), title, viewColumn);
                        } else {
                            await showBrowser(url, title, viewColumn);
                        }
                    } else {
                        if (url.toLowerCase().endsWith('.html') || url.toLowerCase().endsWith('.htm')) {
                            await showWebView(url, title, viewColumn);
                        } else {
                            await showDataView('object', 'txt', title, url, String(viewColumn));
                        }
                    }
                }
                break;
            }
            case 'dataview': {
                if (request.source && request.type && request.title && request.file) {
                    const viewColumnConfig = config().get<Record<string, string>>('session.viewers.viewColumn') ?? {};
                    const viewer = viewColumnConfig['view'] ?? 'Two';
                    if (viewer !== 'Disable') {
                        await showDataView(String(request.source), String(request.type), String(request.title), String(request.file), viewer);
                    }
                }
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
}

// Call from host, pass parsed workspace file
export function updateGuestWorkspace(hostWorkspace: WorkspaceData): void {
    if (hostWorkspace) {
        guestWorkspace = hostWorkspace;
        void rWorkspace?.refresh();
        console.info('[updateGuestWorkspace] Done');
    }
}

// Instead of creating a file, we pass the base64 of the plot image
// to the guest, and read that into an html page
let panel: vscode.WebviewPanel | undefined = undefined;
export function updateGuestPlot(data: string, format: string): void {
    const guestPlotView: vscode.ViewColumn = asViewColumn(config().get<string>('session.viewers.viewColumn.plot'), vscode.ViewColumn.Two);
    if (data) {
        if (panel) {
            panel.webview.html = getGuestImageHtml(data, format);
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
            const content = getGuestImageHtml(data, format);
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
function getGuestImageHtml(content: string, format: string) {
    let imageSrc = '';
    if (format === 'svglite' || format === 'svg') {
        imageSrc = `data:image/svg+xml;base64,${String(content)}`;
    } else {
        imageSrc = `data:image/png;base64,${String(content)}`;
    }

    return `
<!doctype HTML>
<html>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style type="text/css">
    body, html {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background-color: var(--vscode-editor-background);
        display: flex;
        justify-content: center;
        align-items: center;
    }
    img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
    }
    </style>
</head>
<body>
    <img src = "${imageSrc}">
</body>
</html>
`;
}

export async function shareServer(url: URL, name: string): Promise<vscode.Disposable> {
    return liveSession.shareServer({
        port: parseInt(url.port),
        displayName: `${name} (${url.host})`,
        browseUrl: url.toString()
    });
}

// Share and close browser are called from the
// host session
// Automates sharing browser sessions through the
// shareServer method
export async function shareBrowser(url: string, name: string, force: boolean = false): Promise<void> {
    if (autoShareBrowser || force) {
        const _url = new URL(url);
        const disposable = await shareServer(_url, name);
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
