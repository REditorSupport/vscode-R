

import * as vscode from 'vscode';
import * as httpgd from './httpgd';
import * as fs from 'fs';

import { extensionContext } from './extension';

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

    const htmlTemplate = fs.readFileSync(extensionContext.asAbsolutePath('html/httpgd/index.template.html'), 'utf-8');
    const cssUri = panel.webview.asWebviewUri(vscode.Uri.file(extensionContext.asAbsolutePath('html/httpgd/style.css')));
    
    function updatePanel(svg: string){
        const html = htmlTemplate
            .replace('$STYLEPATH', cssUri.toString())
            .replace('$SVG', svg);
        panel.webview.html = html;
    }
    
    api.onChange((svg: string) => {
        updatePanel(svg);
    });
}



