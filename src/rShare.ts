import * as vscode from 'vscode';
import * as vsls from 'vsls';
import * as fs from 'fs-extra';
import { globalenvFile, requestFile } from './session';
import { runTextInTerm } from './rTerminal';
import { updateGuestGlobalenv, updateGuestPlot, updateGuestRequest } from './rShareSession';
import { delay, config } from './util';

// LiveShare
export let rHostService: HostService = undefined;
export let rGuestService: GuestService = undefined;
let liveSession: vsls.LiveShare;

// Service vars
export const UUID = Math.floor(Math.random() * Date.now()); // random number for workspace viewer purposes
const ShareProviderName = 'vscode-r';
const enum ShareRequest {
    NotifyEnvUpdate = 'NotifyEnvUpdate',
    NotifyPlotUpdate = 'NotifyPlotUpdate',
    NotifyRequestUpdate = 'NotifyRequestUpdate',
    NotifyMessage = 'NotifyMessage',
    RequestAttachGuest = 'RequestAttachGuest',
    RequestRunTextInTerm = 'RequestRunTextInTerm',
    GetGlobalenvContent = 'GetGlobalenvContent',
    GetRequestContent = 'GetRequestContent',
    GetFileContent = 'GetFileContent',
}
const enum MessageType {
    information = 'information',
    error = 'error',
    warning = 'warning'
}

// Bool to check if live share is loaded and active
export async function isLiveShare(): Promise<boolean> {
    const shareStarted = (await vsls.getApi())?.session;
    // If there is a hosted session*, return true
    // else return false
    // * using vsls.getApi() instead of vsls.getApi().session.id
    // * will always return true, even if a session is not active
    if (shareStarted) {
        return true;
    } else {
        return false;
    }
}

export async function isGuest(): Promise<boolean> {
    if ((await isLiveShare()) === true) {
        return liveSession.session.role === vsls.Role.Guest ? true : false;
    } else {
        return false;
    }
}

function isTermActive(): boolean {
    const term = vscode.window.activeTerminal.name;
    const termNames = ['R', 'R Interactive'];
    return (termNames.includes(term)) ? true : false;
}

// Listens for the activation of a LiveShare session
export async function LiveSessionListener(): Promise<void> {
    const attachGuestBool: boolean = config().get('liveShare.attachGuestsOnJoin');
    const attachDelay: number = config().get('liveShare.guestAttachDelay');
    rHostService = new HostService;
    rGuestService = new GuestService;

    console.log('[LiveSessionListener] started');
    const liveSessionStatus = await vsls.getApi();
    if (!liveSessionStatus) { return; }
    liveSession = liveSessionStatus;

    // If a guest joins and there is an active R terminal,
    // attach terminal
    // * Can be disabled in settings
    liveSession.onDidChangePeers(async e => {
        if (liveSession.session.role === vsls.Role.Host) {
            if (e.added.length > 0) {
                if (isTermActive() && attachGuestBool) {
                    await delay(attachDelay); // await guest warmup
                    await runTextInTerm(`.vsc.attach()`);
                }
            }
        }
    });

    liveSession.onDidChangeSession(async (e: vsls.SessionChangeEvent) => {
        switch (e.session.role) {
            case vsls.Role.None:
                console.log('[LiveSessionListener] no-role event');
                break;
            case vsls.Role.Guest:
                console.log('[LiveSessionListener] guest event');
                await rGuestService.startService();
                break;
            case vsls.Role.Host:
                console.log('[LiveSessionListener] host event');
                await rHostService.startService();
                break;
            default:
                console.log('[LiveSessionListener] default case');
                break;
        }
    }, null);

    // onDidChangeSession does not seem to be activating for anyone
    // other than host, seems to be a regression in the vsls api
    // this is a workaround for the time being
    switch (liveSession.session.role) {
        case vsls.Role.None:
            break;
        case vsls.Role.Guest:
            console.log('[LiveSessionListener] guest event');
            await rGuestService.startService();
            break;
        default:
            console.log('[LiveSessionListener] host event');
            await rHostService.startService();
            break;
    }
}

export class HostService {
    private service: vsls.SharedService | null = null;
    private _isStarted: boolean = false;
    // Service state getter
    public isStarted(): boolean {
        if (this._isStarted === true) {
            return true;
        } else {
            return false;
        }
    }
    public async startService(): Promise<void> {
        this.service = await liveSession.shareService(ShareProviderName);
        if (this.service) {
            this._isStarted = true;
            /// File Handling ///
            // Host reads content from file, then passes the content
            // to the guest session.
            this.service.onRequest(ShareRequest.GetRequestContent, async (): Promise<string> => {
                return await fs.readFile(requestFile, 'utf8');
            });
            this.service.onRequest(ShareRequest.GetGlobalenvContent, async (): Promise<string> => {
                return await fs.readFile(globalenvFile, 'utf8');
            });
            this.service.onRequest(ShareRequest.GetFileContent, async (args: [text: string]): Promise<string> => {
                return await fs.readFile(args[0], 'utf8');
            });
            /// Terminal commands //
            // Command arguments are sent from the guest to the host,
            // and then the host sends the arguments to the console
            this.service.onRequest(ShareRequest.RequestAttachGuest, async (): Promise<void> => {
                const attachGuestBool: boolean = config().get('liveShare.allowGuestAttach');
                if (attachGuestBool === true) {
                    if (isTermActive() === true) {
                        await runTextInTerm(`.vsc.attach()`);
                    } else {
                        this.service.notify(ShareRequest.NotifyMessage, { text: 'Cannot attach guest terminal. Must have active host R terminal.', messageType: MessageType.information });
                    }
                } else {
                    this.service.notify(ShareRequest.NotifyMessage, { text: 'The host has not enabled guest attach.', messageType: MessageType.warning });
                }
            });
            this.service.onRequest(ShareRequest.RequestRunTextInTerm, (args: [text: string]) => {
                const commandForwardBool: boolean = config().get('liveShare.allowCommandForwarding');
                if (commandForwardBool === true) {
                    if (isTermActive() === true) {
                        void runTextInTerm(`${args[0]}`);
                    } else {
                        this.service.notify(ShareRequest.NotifyMessage, { text: 'Cannot call command. Must have active host R terminal.', messageType: MessageType.warning });
                    }
                } else {
                    this.service.notify(ShareRequest.NotifyMessage, { text: 'The host has not enabled command forwarding. Command was not sent.', messageType: MessageType.warning });
                }

            });
        } else {
            console.error('[HostService] service activation failed');
        }
    }
    /// Session Syncing
    // These are called from the host in order to tell the guest session
    // to update the env/request/plot
    public notifyGlobalenv(): void {
        if (this.isStarted) {
            void this.service.notify(ShareRequest.NotifyEnvUpdate, {});
        }
    }
    public notifyRequest(): void {
        if (this.isStarted) {
            void this.service.notify(ShareRequest.NotifyRequestUpdate, {});
        }
    }
    public notifyPlot(file: string): void {
        if (this.isStarted) {
            void this.service.notify(ShareRequest.NotifyPlotUpdate, { file });
        }
    }
}

export class GuestService {
    private service: vsls.SharedServiceProxy | null = null;
    private _isStarted: boolean = true;
    private _sessionStatusBarItem: vscode.StatusBarItem;
    public async startService(): Promise<void> {
        this.service = await liveSession.getSharedService(ShareProviderName);
        if (this.service === null) {
            console.error('[GuestService] service request failed');
        } else {
            this._isStarted = true;
            /// Session Syncing
            this.service.onNotify(ShareRequest.NotifyEnvUpdate, (): void => {
                void updateGuestGlobalenv();
            });
            this.service.onNotify(ShareRequest.NotifyRequestUpdate, (): void => {
                void updateGuestRequest(this._sessionStatusBarItem);
            });
            this.service.onNotify(ShareRequest.NotifyPlotUpdate, (args: { file: string }): void => {
                void updateGuestPlot(args.file);
            });
            this.service.onNotify(ShareRequest.NotifyMessage, (args: { text: string, messageType: MessageType }): void => {
                switch (args.messageType) {
                    case MessageType.error:
                        return void vscode.window.showErrorMessage(args.text);
                    case MessageType.information:
                        return void vscode.window.showInformationMessage(args.text);
                    case MessageType.warning:
                        return void vscode.window.showWarningMessage(args.text);
                    case undefined:
                        return void vscode.window.showInformationMessage(args.text);
                }
            });
        }
    }
    public isStarted(): boolean {
        if (this._isStarted === true) {
            return true;
        } else {
            void vscode.window.showErrorMessage('The vscode-R liveshare service failed to start. Ensure that you and the host are using the latest version of vscode-R.');
            return false;
        }
    }
    public setStatusBarItem(sessionStatusBarItem: vscode.StatusBarItem): void {
        this._sessionStatusBarItem = sessionStatusBarItem;
    }
    // The guest requests the host runs .vsc.attach() in the active R terminal
    // This ensures that commands are sent to the same terminal as the host
    // This also ensures that guests without read/write access can still view the
    // R workspace
    public requestAttach(): void {
        if (this.isStarted) {
            void this.service.request(ShareRequest.RequestAttachGuest, []);
        }
    }
    // Used to ensure that the guest can run workspace viewer commands, e.g. view, remove, clean
    public requestRunTextInTerm(text: string): void {
        if (this._isStarted) {
            void this.service.request(ShareRequest.RequestRunTextInTerm, [text]);
        }
    }
    // As we can't expose the host files directly, we get the host to return the read file content
    // to the guest session
    public async getRequestContent(): Promise<string> {
        if (this._isStarted) {
            const returnedFile: string | unknown = await this.service.request(ShareRequest.GetRequestContent, []);
            if (typeof returnedFile === 'string') {
                return returnedFile;
            } else {
                console.log('[GuestService] failed to retrieve request content (not of type "string")');
            }
        }
    }
    public async getGlobalenvContent(): Promise<string> {
        if (this._isStarted) {
            const returnedFile: string | unknown = await this.service.request(ShareRequest.GetGlobalenvContent, []);
            if (typeof returnedFile === 'string') {
                return returnedFile;
            } else {
                console.log('[GuestService] failed to retrieve globalenv content (not of type "string")');
            }
        }
    }
    public async requestFileContent(file: string): Promise<string> {
        if (this._isStarted) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            const content: string | unknown = await this.service.request(ShareRequest.GetFileContent, [file]);
            if (typeof content === 'string') {
                return content;
            } else {
                console.log('[GuestService] failed to retrieve file content (not of type "string")');
            }
        }
    }
}