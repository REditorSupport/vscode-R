import * as vscode from 'vscode';
import * as vsls from 'vsls';

export const LiveSessionBool = isLiveShare();
let sharedResDir: string = undefined;
let sharedWatcherDir: string = undefined;

// Bool to check if live share is loaded and active
export async function isLiveShare(): Promise<boolean> {
    const shareExists = vscode.extensions.getExtension('ms-vsliveshare.vsliveshare') !== null ? true : false;
    const shareStarted = (await vsls.getApi()).session.id !== null ? true : false;
    if (shareExists && shareStarted) {
        return true;
    } else {
        return false;
    }
}

// Convert resDir uri to a shared uri
// This is returned for guest sessions
export async function ExposeResDir(_resDir: string): Promise<string> {
    const liveSession: vsls.LiveShare | null = await vsls.getApi();
    const resDir = vscode.Uri.parse(_resDir);
    const user = liveSession.session.role;

    if (user === vsls.Role.Host) {
        sharedResDir = liveSession.convertLocalUriToShared(resDir).toString();
        return _resDir;
    } else if (user === vsls.Role.Guest) {
        return sharedResDir;
    } else {
        return _resDir;
    }
}

// Convert watcherDir uri to a shared uri
// This is returned for guest sessions
export async function ExposeWatcherDir(_watcherDir: string): Promise<string> {
    const liveSession: vsls.LiveShare | null = await vsls.getApi();
    const watcherDir = vscode.Uri.parse(_watcherDir);
    const user = liveSession.session.role;

    if (user === vsls.Role.Host) {
        sharedWatcherDir = liveSession.convertSharedUriToLocal(watcherDir).toString();
        return _watcherDir;
    } else if (user === vsls.Role.Guest) {
        return sharedWatcherDir;
    } else {
        return _watcherDir;
    }
}
