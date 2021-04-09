

import * as vscode from 'vscode';
import * as httpgd from './httpgd';
import * as path from 'path';
import * as fs from 'fs';
import * as ejs from 'ejs';

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
    
    const htmlRoot = extensionContext.asAbsolutePath('html/httpgd');
    const indexTemplate = fs.readFileSync(path.join(htmlRoot, 'index.ejs'), 'utf-8');

    function asWebViewPath(localPath: string){
        const localUri = vscode.Uri.file(path.join(htmlRoot, localPath));
        const webViewUri = panel.webview.asWebviewUri(localUri);
        return webViewUri.toString();
    }
    
    const ejsData: ejs.Data = {
        asWebViewPath: asWebViewPath
    };
    
    let plots: string[] = [];

    function updatePanel(newPlots?: string[], index?: number){
        plots = newPlots || plots;
        index ??= plots.length - 1;

        ejsData.activeIndex = index;
        ejsData.svg = plots[index];
        ejsData.plots = plots;
        const html = ejs.render(indexTemplate, ejsData);
        panel.webview.html = html;
    }

    vscode.commands.registerCommand('r.httpgd.showIndex', (index?: number) => {
        updatePanel(undefined, index);
    });
    
    api.onChange((svg: string, plots: string[]) => {
        updatePanel(plots);
    });
}



