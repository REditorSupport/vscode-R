import * as vscode from 'vscode';
import * as vsls from 'vsls';
import * as fs from 'fs-extra';
import { doesTermExist } from './util';
import { requestFile } from './session';
import { runTextInTerm } from './rTerminal';
import { enableSessionWatcher } from './extension';
import { attachActiveGuest, detachGuest, initGuest, updateGuestGlobalenv, updateGuestPlot, updateGuestRequest } from './rShareSession';
import { forwardCommands, initTreeView, rLiveShareProvider, shareWorkspace, ToggleNode } from './rShareTree';

// LiveShare
export let rHostService: HostService = undefined;
export let rGuestService: GuestService = undefined;
export let liveSession: vsls.LiveShare;
export let isGuestSession: boolean;
export let _sessionStatusBarItem: vscode.StatusBarItem;
export const UUID = Math.floor(Math.random() * Date.now()); // random number to fake a UUID for workspace viewer purposes

/// Share Service Variables
// the service name that is used to share content between
// the host and the guest
const ShareProviderName = 'vscode-r';
let service: vsls.SharedServiceProxy | vsls.SharedService | null;

/// state-tracking bools
// Bool to check if live share is loaded and active
export async function isLiveShare(): Promise<boolean> {
    const shareStarted = (await vsls.getApi())?.session.id;
    // If there is a hosted session*, return true
    // else return false
    // * using vsls.getApi() instead of vsls.getApi().session.id
    // * will always return true, even if a session is not active
    // * (a session id will only exist if a session is active)
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


// used for notify & request events
// to prevent accidental typos


const enum Callback {
    NotifyEnvUpdate = 'NotifyEnvUpdate',
    NotifyPlotUpdate = 'NotifyPlotUpdate',
    NotifyRequestUpdate = 'NotifyRequestUpdate',
    NotifyMessage = 'NotifyMessage',
    RequestAttachGuest = 'RequestAttachGuest',
    RequestRunTextInTerm = 'RequestRunTextInTerm',
    GetFileContent = 'GetFileContent',
    OrderDetach = 'OrderDetach'
}

// used in sending messages to the
// guest service
const enum MessageType {
    information = 'information',
    error = 'error',
    warning = 'warning'
}

interface ICommands {
    host: {
        [name: string]: unknown
    },
    guest: {
        [name: string]: unknown
    }
}

// To contribute a request between the host and guest,
// add the method that will be triggered with the callback.
//
// e.g.to contribute a host callback, create a method under
// the host section.when you want to trigger the callback,
// call request(method) from the guest service
//
// method arguments should be defined as an array of 'args'
// e.g. 'name': (args: [*all args here*]) => {}
const commands: ICommands = {
    'host': {
        /// Terminal commands ///
        // Command arguments are sent from the guest to the host,
        // and then the host sends the arguments to the console
        'RequestAttachGuest': (): void => {
            if (shareWorkspace === true) {
                if (doesTermExist() === true) {
                    const req = requestFile;
                    void rHostService.notifyRequest(req, true);
                } else {
                    void request(Callback.NotifyMessage, 'Cannot attach guest terminal. Must have active host R terminal.', MessageType.error);
                }
            } else {
                void request(Callback.NotifyMessage, 'The host has not enabled guest attach.', MessageType.warning);
            }
        },
        'RequestRunTextInTerm': (args: [text: string]) => {
            if (forwardCommands === true) {
                if (doesTermExist() === true) {
                    void runTextInTerm(`${args[0]}`);
                } else {
                    void request(Callback.NotifyMessage, 'Cannot call command. Must have active host R terminal.', MessageType.warning);
                }
            } else {
                    void request(Callback.NotifyMessage, 'The host has not enabled command forwarding. Command was not sent.', MessageType.warning);
            }

        },
        /// File Handling ///
        // Host reads content from file, then passes the content
        // to the guest session.
        'GetFileContent': async (args: [text: string, encoding?: string]): Promise<string | Buffer> => {
            if (typeof (args[1]) !== 'undefined') {
                return await fs.readFile(args[0], args[1]);
            } else {
                return await fs.readFile(args[0]);
            }
        }
    },
    'guest': {
        'NotifyRequestUpdate': (args: [ file: string, force: boolean ]): void => {
            void updateGuestRequest(args[0], args[1]);
        },
        'NotifyEnvUpdate': (args: [ file: string ]): void => {
            void updateGuestGlobalenv(args[0]);
        },
        'NotifyPlotUpdate': (args: [ file: string ]): void => {
            void updateGuestPlot(args[0]);
        },
        'OrderDetach': (): void => {
            void detachGuest();
        },
        /// vscode Messages ///
        // The host sends messages to the guest, which are displayed as a vscode window message
        // E.g., teling the guest a terminal is not attached to the current session
        // This way, we don't have to do much error checking on the guests side, which is more secure
        // and less prone to error
        'NotifyMessage': (args: [ text: string, messageType: MessageType ]): void => {
            switch (args[1]) {
                case MessageType.error:
                    return void vscode.window.showErrorMessage(args[0]);
                case MessageType.information:
                    return void vscode.window.showInformationMessage(args[0]);
                case MessageType.warning:
                    return void vscode.window.showWarningMessage(args[0]);
                case undefined:
                    return void vscode.window.showInformationMessage(args[0]);
            }
        }
    }
};

// The following onRequest and request methods are wrapper
// around the vsls RPC API. These are intended to simplify
// the API, so that the learning curve is minimal for contributing
// more callbacks.
//
// You can see that the onNotify and notify methods have been
// aggregated under these two methods. This is because the host service
// has no request methods, and for *most* purposes, there is little functional
// difference between the methods.
async function onRequest(name: string, command: unknown, service: vsls.SharedService | vsls.SharedServiceProxy | null): Promise<void> {
    if (await isGuest()) {
        // is guest service
        (service as vsls.SharedServiceProxy).onNotify(name, command as vsls.NotifyHandler);
    } else {
        // is host service
        (service as vsls.SharedService).onRequest(name, command as vsls.RequestHandler);
    }
}

async function request(name: string, ...rest: unknown[]) {
    if (await isGuest()) {
        if (rest !== undefined) {
            return (service as vsls.SharedServiceProxy).request(name, rest);
        } else {
            return (service as vsls.SharedServiceProxy).request(name, []);
        }
    } else {
        if (rest !== undefined) {
            return (service as vsls.SharedService).notify(name, { ...rest });
        } else {
            return (service as vsls.SharedService).notify(name, { });
        }
    }
}

// Initialises the Liveshare functionality for host & guest
// * session watcher is required *
export async function initLiveShare(context: vscode.ExtensionContext): Promise<void> {
    if (enableSessionWatcher) {
        await LiveSessionListener();
        isGuestSession = await isGuest();
        if (!isGuestSession) {
            // Construct tree view for host
            initTreeView();
        } else {
            // Construct guest session watcher
            initGuest(context);
        }

        // Set context value for hiding buttons for guests
        void vscode.commands.executeCommand('setContext', 'r.liveShare:isGuest', isGuestSession);

        // push command for hosts
        context.subscriptions.push(
            vscode.commands.registerCommand(
                'r.liveShare.toggle', (node: ToggleNode) => node.toggle(rLiveShareProvider)
            ),
            vscode.commands.registerCommand('r.attachActiveGuest', () => attachActiveGuest())
        );
    }
}

// Listens for the activation of a LiveShare session
export async function LiveSessionListener(): Promise<void> {
    rHostService = new HostService;
    rGuestService = new GuestService;

    // Return out when the vsls extension isn't
    // installed/available
    const liveSessionStatus = await vsls.getApi();
    if (!liveSessionStatus) { return; }
    liveSession = liveSessionStatus;
    console.log('[LiveSessionListener] started');

    // When the session state changes, attempt to
    // start a liveSession service, which is responsible
    // for providing session-watcher functionality
    // to guest sessions
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
                rLiveShareProvider.refresh();
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

// Communication between the HostService and the GuestService
// typically falls under 2 communication paths (there are exceptions):
//
// 1. a function on the HostService is called, which pushes
// an event (notify), which is picked up by a callback (onNotify)
// e.g. rHostService.notifyRequest
//
// 2. a function on the GuestService is called, which pushes a
// request to the HostService, which is picked up the HostService
// callback and * returned * to the GuestService
// e.g. rGuestService.requestFileContent
export class HostService {
    private _isStarted: boolean = false;
    // Service state getter
    public isStarted(): boolean {
        return this._isStarted;
    }
    public async startService(): Promise<void> {
        // Provides core liveshare functionality
        // The shared service is used as a RPC service
        // to pass messages between the host and guests
        service = await liveSession.shareService(ShareProviderName);
        if (service) {
            this._isStarted = true;
            for (const command in commands.host) {
                void onRequest(command, commands.host[command], service);
            }
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
            void request(Callback.NotifyEnvUpdate, file);
        }
    }
    public notifyRequest(file: string, force: boolean = false): void {
        if (this.isStarted) {
            void request(Callback.NotifyRequestUpdate, file, force);
        }
    }
    public notifyPlot(file: string): void {
        if (this.isStarted) {
            void request(Callback.NotifyPlotUpdate, file);
        }
    }
    orderGuestDetach(): void {
        if (this.isStarted) {
            void request(Callback.OrderDetach);
        }
    }
}

export class GuestService {
    private _isStarted: boolean = true;
    public isStarted(): boolean {
        if (this._isStarted === true) {
            return true;
        } else {
            void vscode.window.showErrorMessage('The vscode-R liveshare service failed to start. Ensure that you and the host are using the latest version of vscode-R and have thesession watcher enabled.');
            return false;
        }
    }
    public async startService(): Promise<void> {
        service = await liveSession.getSharedService(ShareProviderName);
        if (service) {
            this._isStarted = true;
            this.requestAttach();
            for (const command in commands.guest) {
                void onRequest(command, commands.guest[command], service);
            }
        } else {
            console.error('[GuestService] service request failed');
        }
    }
    public setStatusBarItem(sessionStatusBarItem: vscode.StatusBarItem): void {
        _sessionStatusBarItem = sessionStatusBarItem;
    }
    // The guest requests the host runs .vsc.attach() in the active R terminal
    // This ensures that commands are sent to the same terminal as the host
    // This also ensures that guests without read/write access can still view the
    // R workspace
    public requestAttach(): void {
        if (this.isStarted) {
            void request(Callback.RequestAttachGuest);
            // focus guest term
            const rTermNameOptions = ['R [Shared]', 'R Interactive [Shared]'];
            const activeTerminalName = vscode.window.activeTerminal.name;
            if (!rTermNameOptions.includes(activeTerminalName)) {
                for (const [i] of vscode.window.terminals.entries()) {
                    const terminal = vscode.window.terminals[i];
                    const terminalName = terminal.name;
                    if (rTermNameOptions.includes(terminalName)) {
                        terminal.show(true);
                    }
                }
            }
        }
    }
    // Used to ensure that the guest can run workspace viewer commands
    // e.g.view, remove, clean
    // * Permissions are handled host-side
    public requestRunTextInTerm(text: string): void {
        if (this._isStarted) {
            void request(Callback.RequestRunTextInTerm, text);
        }
    }
    // The session watcher relies on files for providing many functions to vscode-R.
    // As LiveShare does not allow for exposing files outside a given workspace,
    // the guest must rely on the host sending the content of a given file, in place
    // of having their own /tmp/ files*
    // * in some cases, creating a file on the guest side is necessary,
    // * such as dataview files or plot images
    public async requestFileContent(file: fs.PathLike | number): Promise<Buffer>;
    public async requestFileContent(file: fs.PathLike | number, encoding: string): Promise<string>;
    public async requestFileContent(file: fs.PathLike | number, encoding?: string): Promise<string | Buffer> {
        if (this._isStarted) {
            if (encoding !== undefined) {
                const content: string | unknown = await request(Callback.GetFileContent, file, encoding);
                if (typeof content === 'string') {
                    return content;
                } else {
                    console.error('[GuestService] failed to retrieve file content (not of type "string")');
                }
            } else {
                const content: Buffer | unknown = await request(Callback.GetFileContent, file);
                if (content !== undefined) {
                    return content as Buffer;
                } else {
                    console.error('[GuestService] failed to retrieve file content (not of type "Buffer")');
                }
            }
        }
    }
}
