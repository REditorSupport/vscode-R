import * as vscode from 'vscode';
import * as vsls from 'vsls';
import { runTextInTerm } from './rTerminal';

export const LiveSessionBool = isLiveShare();
const liveSession: Promise<vsls.LiveShare> | null = vsls.getApi();
const user = liveSession.then(e => e.session.role);
let sharedResDir: string = undefined;
let sharedWatcherDir: string = undefined;

// TODO * RCC doesn't seem to be functioning here at all
export async function AttachOnJoin(): Promise<void> {
    let attachService: vsls.SharedService | vsls.SharedServiceProxy | null;
    (await liveSession).onDidChangeSession(async sessionEvent => {
        if (sessionEvent.session.role === vsls.Role.Host) {
            attachService = await (await liveSession).shareService('attachService');
            attachService?.onRequest('attachGuest', () => {
                void runTextInTerm(`.vsc.attach()`);
            });
        } else {
            attachService = await (await liveSession).getSharedService('attachService');
            if (!attachService) { return; }
            void attachService.request('attachGuest', []);
        }
    });
}

// Bool to check if live share is loaded and active
export async function isLiveShare(): Promise<boolean> {
    const shareExists = vscode.extensions.getExtension('ms-vsliveshare.vsliveshare') !== null ? true : false;
    const shareStarted = (await vsls.getApi()).session.id !== null ? true : false;

    // If the LiveShare extension is installed
    // and there is a hosted session*, return true
    // else return false
    // -> using vsls.getApi() on its own will return true
    //    even if there is no session being hosted
    if (shareExists && shareStarted) {
        return true;
    } else {
        return false;
    }
}

// Convert resDir uri to a shared uri
// This is returned for guest sessions
export async function ExposeResDir(_resDir: string): Promise<string> {
    const resDir = vscode.Uri.parse(_resDir);

    // If the session user is the host, set resDir to a converted
    // resDir. Guests will use the sharedResDir.
    if (await user === vsls.Role.Host) {
        sharedResDir = (await liveSession).convertLocalUriToShared(resDir).toString();
        return _resDir;
    } else if (await user === vsls.Role.Guest) {
        return sharedResDir;
    } else {
        return _resDir;
    }
}

// Convert watcherDir uri to a shared uri
// This is returned for guest sessions
export async function ExposeWatcherDir(_watcherDir: string): Promise<string> {
    const watcherDir = vscode.Uri.parse(_watcherDir);

    // If the session user is the host, set sharedWatcherDir to a converted
    // watcherDir. Guests will use the sharedWatcherDir.
    if (await user === vsls.Role.Host) {
        sharedWatcherDir = (await liveSession).convertSharedUriToLocal(watcherDir).toString();
        return _watcherDir;
    } else if (await user === vsls.Role.Guest) {
        return sharedWatcherDir;
    } else {
        return _watcherDir;
    }
}
