import { Uri } from 'vscode';
import * as vsls from 'vsls';

// Returns the current LiveShare user
export async function LiveSession() {

    const liveSession: vsls.LiveShare | null = await vsls.getApi();

    liveSession.onDidChangeSession(user => {
        if (user.session.role === vsls.Role.Host) {
            return user;
        } else if (user.session.role === vsls.Role.Guest) {
            return user;
        } else {
            return null;
        }
    }
    );
}

// Exposes the globalenv to the LiveShare session
// If the user === host, we return a local -> shared uri
// if the user === guest, we return a shared -> local uri
export async function ExposeEnvironment(user: vsls.SessionChangeEvent, _globalenv: string): Promise<string> {
    const liveSession: vsls.LiveShare | null = await vsls.getApi();
    const globalenv = Uri.parse(_globalenv);

    if (user.session.role === vsls.Role.Host) {
        return  liveSession.convertLocalUriToShared(globalenv).toString();
    } else if (user.session.role === vsls.Role.Guest) {
        return liveSession.convertSharedUriToLocal(globalenv).toString();
    } else {
        return null;
    }
}

export async function ExposeRequestWatcher(user: vsls.SessionChangeEvent, _watcherDir: string): Promise<string> {
    const liveSession: vsls.LiveShare | null = await vsls.getApi();
    const watcherDir = Uri.parse(_watcherDir);

    if (user.session.role === vsls.Role.Host) {
        return liveSession.convertLocalUriToShared(watcherDir).toString();
    } else if (user.session.role === vsls.Role.Guest) {
        return liveSession.convertSharedUriToLocal(watcherDir).toString();
    } else {
        return null;
    }
}