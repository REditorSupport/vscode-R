import path = require('path');
import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as vsls from 'vsls';

import { globalRHelp, rWorkspace } from './extension';
import { config, readContent } from './util';
import { removeDirectory, showBrowser, showDataView, showWebView } from './session';
import { liveSession, UUID, rGuestService, _sessionStatusBarItem as sessionStatusBarItem } from './rShare';
import { autoShareBrowser } from './rShareTree';

// Workspace Vars
let guestPid: string;
let guestPlotView: string;
let guestSessionDir: string;
export let guestGlobalenv: unknown;
export let guestResDir: string;

// Browser Vars
// Used to keep track of shared browsers
export const browserDisposables: { Disposable: vscode.Disposable, url: string }[] = [];

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
    args?: any;
    sd?: string;
    url?: string;
    requestPath?: string;
    UUID?: number;
    tempdir?: string;
}

function guestHasAccess(): boolean {
    return sessionStatusBarItem.text === 'Guest R: (not attached)' ? false : true;
}

export function initGuest(context: vscode.ExtensionContext): void {
    // create status bar item that contains info about the *guest* session watcher
    console.info('Create guestSessionStatusBarItem');
    const sessionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    sessionStatusBarItem.command = 'r.attachActiveGuest';
    sessionStatusBarItem.text = 'Guest R: (not attached)';
    sessionStatusBarItem.tooltip = 'Attach to Host Terminal';
    sessionStatusBarItem.show();
    context.subscriptions.push(sessionStatusBarItem);
    rGuestService.setStatusBarItem(sessionStatusBarItem);
    guestResDir = path.join(context.extensionPath, 'dist', 'resources');
}

export function detachGuest(): void {
    console.info('[Guest Service] detach guest from workspace');
    sessionStatusBarItem.text = 'Guest R: (not attached)';
    guestGlobalenv = undefined;
    rWorkspace.refresh();
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
export async function updateGuestRequest(file : string, force: boolean = false): Promise<void> {
    const requestContent: string = await readContent(file, 'utf8');
    console.info(`[updateGuestRequest] request: ${requestContent}`);
    if (typeof (requestContent) === 'string') {
        const request: IRequest = JSON.parse(requestContent) as IRequest;
        if (request && !force) {
            if (guestHasAccess()) {
                if (request.UUID === null || request.UUID === undefined || request.UUID === UUID) {
                    switch (request.command) {
                        case 'help': {
                            if (globalRHelp) {
                                console.log(request.requestPath);
                                void globalRHelp.showHelpForPath(request.requestPath, request.viewer);
                            }
                            break;
                        }
                        case 'attach': {
                            guestPid = String(request.pid);
                            guestPlotView = String(request.plot);
                            guestSessionDir = path.join(request.tempdir, 'vscode-R');
                            console.info(`[updateGuestRequest] attach PID: ${guestPid}`);
                            sessionStatusBarItem.text = `Guest R: ${guestPid}`;
                            sessionStatusBarItem.show();
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
            }
        } else {
            guestPid = String(request.pid);
            guestPlotView = String(request.plot);
            console.info(`[updateGuestRequest] attach PID: ${guestPid}`);
            sessionStatusBarItem.text = `Guest R: ${guestPid}`;
            sessionStatusBarItem.show();
        }
    }
}

// Call from host, pass globalenvfile
export async function updateGuestGlobalenv(file: string): Promise<void> {
    if (guestHasAccess()) {
        const content: string = await readContent(file, 'utf8');
        if (typeof content === 'string') {
            guestGlobalenv = JSON.parse(content);
            void rWorkspace?.refresh();
            console.info('[updateGuestGlobalenv] Done');
        }
    }
}

export async function updateGuestPlot(file: string): Promise<void> {
    const plotContent = await readContent(file, 'base64');
    if (plotContent !== undefined) {
        fs.outputFileSync(
            file,
            plotContent,
            'base64'
        );
        void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), {
            preserveFocus: true,
            preview: true,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            viewColumn: vscode.ViewColumn[guestPlotView],
        });

    }
}

// Share and close browser are called from the
// host session
// Automates sharing browser sessions through the
// shareServer method
export async function shareBrowser(url: string, name: string): Promise<void> {
    if (autoShareBrowser) {
        const _url = new URL(url);
        const server: vsls.Server = {
            port: parseInt(_url.port),
            displayName: name,
            browseUrl: url,
        };
        const disposable = await liveSession.shareServer(server);
        browserDisposables.push({ Disposable: disposable, url });
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

export function removeGuestFiles(): void {
    console.info('[removeGuestFiles] ', guestSessionDir);
    if (fs.existsSync(guestSessionDir)) {
        removeDirectory(guestSessionDir);
    }
    console.info('[removeSessionFiles] Done');
}