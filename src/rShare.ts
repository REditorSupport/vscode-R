import * as vscode from 'vscode';
import * as vsls from 'vsls';
import * as fs from 'fs-extra';
import { runTextInTerm } from './rTerminal';
import { updateGuestGlobalenv, updateGuestPlot, updateGuestRequest } from './rShareSession';
import { config, isTermActive } from './util';

// LiveShare
export let rHostService: HostService = undefined;
export let rGuestService: GuestService = undefined;
export let liveSession: vsls.LiveShare;

// Service vars
export const UUID = Math.floor(Math.random() * Date.now()); // random number to fake a UUID for workspace viewer purposes
const ShareProviderName = 'vscode-r';
const enum ShareRequest {
    NotifyEnvUpdate = 'NotifyEnvUpdate',
    NotifyPlotUpdate = 'NotifyPlotUpdate',
    NotifyRequestUpdate = 'NotifyRequestUpdate',
    NotifyMessage = 'NotifyMessage',
    RequestAttachGuest = 'RequestAttachGuest',
    RequestRunTextInTerm = 'RequestRunTextInTerm',
    GetFileContent = 'GetFileContent',
}
const enum MessageType {
    information = 'information',
    error = 'error',
    warning = 'warning'
}

// Bool to check if live share is loaded and active
export async function isLiveShare(): Promise<boolean> {
    const shareStarted = (await vsls.getApi())?.session.id;
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

export async function isHost(): Promise<boolean> {
    if ((await isLiveShare()) === true) {
        return liveSession.session.role === vsls.Role.Host ? true : false;
    } else {
        return false;
    }
}

// Listens for the activation of a LiveShare session
export async function LiveSessionListener(): Promise<void> {
    rHostService = new HostService;
    rGuestService = new GuestService;
    console.log('[LiveSessionListener] started');
    const liveSessionStatus = await vsls.getApi();
    if (!liveSessionStatus) { return; }
    liveSession = liveSessionStatus;

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
        // Provides core liveshare functionality
        // The shared service is used as a RPC service
        // to pass messages between the host and guests
        this.service = await liveSession.shareService(ShareProviderName);
        if (this.service) {
            this._isStarted = true;
            /// File Handling ///
            // Host reads content from file, then passes the content
            // to the guest session.
            this.service.onRequest(ShareRequest.GetFileContent, async (args: [text: string, encoding?: string]): Promise<string | Buffer> => {
                if (typeof (args[1]) !== 'undefined') {
                    return await fs.readFile(args[0], args[1]);
                } else {
                    return await fs.readFile(args[0]);
                }
            });
            /// Terminal commands ///
            // Command arguments are sent from the guest to the host,
            // and then the host sends the arguments to the console
            this.service.onRequest(ShareRequest.RequestAttachGuest, async (): Promise<void> => {
                const attachGuestBool: boolean = config().get('liveShare.allowGuestAttach');
                if (attachGuestBool === true) {
                    if (isTermActive() === true) {
                        await runTextInTerm(`.vsc.attach()`);
                    } else {
                        this.service.notify(ShareRequest.NotifyMessage, { text: 'Cannot attach guest terminal. Must have active host R terminal.', messageType: MessageType.error });
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
    /// Session Syncing ///
    // These are called from the host in order to tell the guest session
    // to update the env/request/plot
    // This way, we don't have to re-create a guest version of the session
    // watcher, and can rely on the host to tell when something needs to be
    // updated
    public notifyGlobalenv(file: string): void {
        if (this.isStarted) {
            void this.service.notify(ShareRequest.NotifyEnvUpdate, { file });
        }
    }
    public notifyRequest(file: string): void {
        if (this.isStarted) {
            void this.service.notify(ShareRequest.NotifyRequestUpdate, { file });
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
            // Try to get attach guest to host terminal
            this.requestAttach();
            /// Session Syncing ///
            this.service.onNotify(ShareRequest.NotifyEnvUpdate, (args: { file: string }): void => {
                void updateGuestGlobalenv(args.file);
            });
            this.service.onNotify(ShareRequest.NotifyRequestUpdate, (args: { file: string }): void => {
                void updateGuestRequest(this._sessionStatusBarItem, args.file);
            });
            this.service.onNotify(ShareRequest.NotifyPlotUpdate, (args: { file: string }): void => {
                void updateGuestPlot(args.file);
            });
            /// vscode Messages ///
            // The host sends messages to the guest, which are displayed as a vscode window message
            // E.g., teling the guest a terminal is not attached to the current session
            //
            // This way, we don't have to do much error checking on the guests side, which is more secure
            // and less prone to error
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
    // * Permissions are handled host-side
    public requestRunTextInTerm(text: string): void {
        if (this._isStarted) {
            void this.service.request(ShareRequest.RequestRunTextInTerm, [text]);
        }
    }
    // The session watcher relies on files for providing many functions to vscode-R.
    // As LiveShare does not allow for exposing files outside a given workspace,
    // the guest must rely on the host sending the content of a given file, in place
    // of having their own /tmp/ files
    public async requestFileContent(file: fs.PathLike | number) : Promise<Buffer>;
    public async requestFileContent(file: fs.PathLike | number, encoding: string): Promise<string>;
    public async requestFileContent(file: fs.PathLike | number, encoding?: string): Promise<string | Buffer> {
        if (this._isStarted) {
            if (encoding !== undefined) {
                const content: string | unknown = await this.service.request(ShareRequest.GetFileContent, [file, encoding]);
                if (typeof content === 'string') {
                    return content;
                } else {
                    console.error('[GuestService] failed to retrieve file content (not of type "string")');
                }
            } else {
                const content: Buffer | unknown = await this.service.request(ShareRequest.GetFileContent, [file]);
                if (content !== undefined) {
                    return content as Buffer;
                } else {
                    console.error('[GuestService] failed to retrieve file content (not of type "Buffer")');
                }
            }
        }
    }
}
