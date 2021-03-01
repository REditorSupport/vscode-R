import * as vscode from 'vscode';
import * as vsls from 'vsls';

export const LiveSessionBool = isLiveShare();
let sharedTerm: vscode.Terminal = undefined;
let sharedEnv: string = undefined;
let sharedSessionDir: string = undefined;
let sharedRequestWatcher: string = undefined;

// Bool to check if live share is loaded and active
export async function isLiveShare(): Promise<boolean> {
    const shareExists = vscode.extensions.getExtension('ms-vsliveshare.vsliveshare') !== null ? true : false;
    const shareLoaded = await vsls.getApi() !== null ? true : false;

    if (shareExists && shareLoaded) {
        return true;
    } else {
        return false;
    }
}

// Exposes the globalenv to the LiveShare session
// If the user === host, we return a local -> shared uri
// if the user === guest, we return a shared -> local uri
export async function ExposeEnvironment(_globalenv: string): Promise<string> {
    const liveSession: vsls.LiveShare | null = await vsls.getApi();
    const globalenv = vscode.Uri.parse(_globalenv);
    const user = liveSession.session.role;

    if (user === vsls.Role.Host) {
        sharedEnv = liveSession.convertLocalUriToShared(globalenv).toString();
        return _globalenv;
    } else if (user === vsls.Role.Guest) {
        return sharedEnv;
    } else {
        return _globalenv;
    }
}

export async function ExposeSessionDir(_sessionDir: string): Promise<string> {
    const liveSession: vsls.LiveShare | null = await vsls.getApi();
    const sessionDir = vscode.Uri.parse(_sessionDir);
    const user = liveSession.session.role;

    if (user === vsls.Role.Host) {
        sharedSessionDir = liveSession.convertLocalUriToShared(sessionDir).toString();
        return _sessionDir;
    } else if (user === vsls.Role.Guest) {
        return sharedSessionDir;
    } else {
        return _sessionDir;
    }
}

export async function ExposeRequestWatcher(_watcherDir: string): Promise<string> {
    const liveSession: vsls.LiveShare | null = await vsls.getApi();
    const watcherDir = vscode.Uri.parse(_watcherDir);
    const user = liveSession.session.role;

    if (user === vsls.Role.Host) {
        sharedRequestWatcher = liveSession.convertSharedUriToLocal(watcherDir).toString();
        return _watcherDir;
    } else if (user === vsls.Role.Guest) {
        return sharedRequestWatcher;
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
        return sharedTerm;
    // Get terminal
    } else  {
        return sharedTerm;
    }
}

// export async function LocalToShared(_path): Promise<string> {
//     const liveSession: vsls.LiveShare | null = await vsls.getApi();
//     const path = vscode.Uri.parse(_path);
//     const user = liveSession.session.role;

//     if (user === vsls.Role.Host) {
//          = liveSession.convertSharedUriToLocal(path).toString();
//         return sharedTerm;
//         // Get terminal
//     } else {
//         return _path;
//     }
// }