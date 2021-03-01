import * as vscode from 'vscode';
import * as vsls from 'vsls';

export const LiveSessionBool = isLiveShare();
let sharedTerm: vscode.Terminal = undefined;
let sharedResDir: string = undefined;
let sharedWatcherDir: string = undefined;
let sharedTermPath: string = undefined;

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

// Here we return the host's chosen terminal to the guest
// This allows for the execution of rTerminal.ts commands
// in the host's terminal from a guest session
export async function ShareHostTerm(_term: vscode.Terminal): Promise<vscode.Terminal> {
    const liveSession: vsls.LiveShare | null = await vsls.getApi();
    const user = liveSession.session.role;

    // Share terminal
    if (user === vsls.Role.Host) {
        sharedTerm = _term;
        return _term;
    // Get terminal
    } else if (user === vsls.Role.Guest) {
        //void vscode.window.showInformationMessage(sharedTerm.toString());
        return sharedTerm;
    } else {
        return _term;
    }
}

export async function ExposeTermPath(_termPath: string): Promise<string> {
    const liveSession: vsls.LiveShare | null = await vsls.getApi();
    const termPath = vscode.Uri.parse(_termPath);
    const user = liveSession.session.role;



    if (user === vsls.Role.Host) {
        sharedTermPath = liveSession.convertSharedUriToLocal(termPath).toString();
        return _termPath;
    } else if (user === vsls.Role.Guest) {
        return sharedTermPath;
    } else {
        return _termPath;
    }
}