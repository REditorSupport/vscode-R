

import * as vscode from 'vscode';
import { Httpgd, HttpgdPlot } from './httpgd';
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

    const api = new Httpgd(host, token);
    api.start();
    
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
    
    let plots: HttpgdPlot[] = [];

    function updatePanel(newPlots?: HttpgdPlot[], index?: number){
        plots = newPlots || plots;
        const plots_svg = plots.map(p => p.svg);

        index ??= plots.length - 1;

        ejsData.activeIndex = index;
        ejsData.svg = plots_svg[index];
        ejsData.plots = plots_svg;
        const html = ejs.render(indexTemplate, ejsData);
        panel.webview.html = html;
    }

    vscode.commands.registerCommand('r.httpgd.showIndex', (index?: number) => {
        updatePanel(undefined, index);
    });
    
    api.onPlotsChange(() => {
        api.getPlotContents().then((plots: HttpgdPlot[]) => {
            updatePanel(plots);
        });
    });
}



