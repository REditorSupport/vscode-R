import { workspace, window } from 'vscode';
export let config = workspace.getConfiguration('r');

export function getRpath() {
    if (process.platform === 'win32') {
        return <string>config.get('rterm.windows');
    } else if (process.platform === 'darwin') {
        return <string>config.get('rterm.mac');
    } else if ( process.platform === 'linux') {
        return <string>config.get('rterm.linux');
    }else {
        window.showErrorMessage(process.platform + "can't use R");
        return "";
    }
}