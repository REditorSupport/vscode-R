import type { Session } from '../session';
import { Uri, WebviewPanel } from 'vscode';

export function plotPanelPath(panel: WebviewPanel | undefined | null): string | undefined {
    if (!panel) {
        return undefined;
    }
    const uri = panel.webview.asWebviewUri(Uri.file(''));
    return `webview-panel/webview-${uri.authority.split('.')[0]}`;
}

export interface PlotViewer {
    readonly id: string;
    readonly isActive?: boolean;
    getPanelPath?(): string | undefined;
    show(preserveFocus?: boolean): void;
    dispose(): void;
    handleCommand(command: string, ...args: unknown[]): void | Promise<void>;
}

export interface PlotManager {
    viewers: PlotViewer[];
    activeViewer: PlotViewer | undefined;
    initialize(): void;
    showStandardPlot(target: Session): Promise<void>;
    showHttpgdPlot(url: string, target?: Session, restoring?: boolean): Promise<void>;
}
