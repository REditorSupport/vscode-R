

import * as vscode from 'vscode';
import * as httpgd from './httpgd';

export function httpgdViewer(urlString: string): void {

    const url = new URL(urlString);

    const host = url.host;
    const token = url.searchParams.get('token');

    const panel = vscode.window.createWebviewPanel(
        'httpgd',
        'httpgd',
        {
            preserveFocus: true,
            viewColumn: vscode.ViewColumn.Two
        },
        {
            enableScripts: true,
            enableCommandUris: true
        }
    );
    const api = new httpgd.HttpgdViewer(host, token, true);
    api.init();
    
    function updatePanel(svg: string){
        panel.webview.html = `${svg}`;
    }
    
    api.onChange((svg: string) => {
        updatePanel(svg);
    });
}



