import type { WebviewPanel } from 'vscode';
import type { SessionProcessMonitor } from './sessionProcessMonitor';

interface ViewerSessionSource {
    sessionId: string;
    host: string;
    pid: string;
    rVer: string;
    processExited: boolean;
}

export interface ViewerSessionContext {
    readonly sessionId: string;
    getHtml(): string;
    attach(panel: WebviewPanel): void;
}

// Shared by the standalone HTML, list and data viewers.
export function createViewerSessionContext<Session extends ViewerSessionSource>(
    owner: Session, monitor: SessionProcessMonitor<Session>,
): ViewerSessionContext {
    return {
        sessionId: owner.sessionId,
        getHtml: () => {
            const exited = monitor.hasExited(owner);
            if (!exited && (!owner.pid || !owner.rVer)) { return ''; }
            const text = exited ? 'R: (not attached)' : formatSessionLabel(owner.rVer, owner.pid);
            const info = text.replace(/[&<>"']/g, character => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
            })[character]!);
            return `<span class="viewer-session" role="img" tabindex="0" aria-label="${info}" aria-describedby="viewer-session-tooltip"><span class="codicon codicon-info" aria-hidden="true"></span><span id="viewer-session-tooltip" class="viewer-session-tooltip" role="tooltip">${info}</span></span>`;
        },
        attach: panel => {
            if (!monitor.hasExited(owner) && (!owner.pid || !owner.rVer)) { return; }
            const attachedLabel = formatSessionLabel(owner.rVer, owner.pid);
            const refresh = (force = false) => {
                const text = source.exited ? 'R: (not attached)' : attachedLabel;
                if (force || text !== lastLabel) {
                    lastLabel = text;
                    void panel.webview.postMessage({ message: 'viewer-session/update', text });
                }
            };
            // Retain the originating process identity through detach and reconnect.
            const source = monitor.observe(owner, refresh);
            let lastLabel = source.exited ? 'R: (not attached)' : attachedLabel;
            const received = panel.webview.onDidReceiveMessage((message: { message?: string }) => {
                if (message?.message === 'viewer-session/ready') { refresh(true); }
            });
            panel.onDidDispose(() => { source.dispose(); received?.dispose(); });
        },
    };
}

export function formatSessionLabel(version: string, pid: string): string {
    const normalized = version.replace(/^R (?:version )?/, '').replace(/\s+\(.*/, '');
    return `R ${normalized}: ${pid}`;
}

export function getViewerSessionScript(): string {
    return `(${initializeViewerSession.toString()})(vscode);`;
}

export function initializeViewerSession(vscode: { postMessage?(message: { message: 'viewer-session/ready' }): unknown }): void {
    window.addEventListener('message', event => {
        const message: unknown = event.data;
        if (!message || typeof message !== 'object' || !('message' in message) ||
            message.message !== 'viewer-session/update' || !('text' in message) || typeof message.text !== 'string') { return; }
        const icon = document.querySelector('.viewer-session');
        const tooltip = document.getElementById('viewer-session-tooltip');
        if (icon && tooltip) {
            icon.setAttribute('aria-label', message.text);
            tooltip.textContent = message.text;
        }
    });
    const initializeViewerSessionInfo = () => {
        const icon = document.querySelector('.viewer-session');
        if (icon) {
            const showTooltip = () => icon.removeAttribute('data-tooltip-dismissed');
            icon.addEventListener('focus', showTooltip);
            icon.addEventListener('pointerenter', showTooltip);
            document.addEventListener('keydown', event => {
                if (event.key === 'Escape' && !icon.hasAttribute('data-tooltip-dismissed') &&
                    icon.matches(':hover, :focus-visible')) {
                    icon.setAttribute('data-tooltip-dismissed', '');
                    event.preventDefault();
                    event.stopPropagation();
                }
            });
            vscode.postMessage?.({ message: 'viewer-session/ready' });
        }
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeViewerSessionInfo, { once: true });
    } else {
        initializeViewerSessionInfo();
    }
}

export const viewerSessionStyle = `
    .viewer-session {
        position: relative; display: inline-flex; flex-shrink: 0; cursor: default;
        color: var(--vscode-descriptionForeground);
    }
    .viewer-session:focus-visible {
        outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px;
    }
    .viewer-session-tooltip {
        position: absolute; top: calc(100% + 6px); right: 0; z-index: 1000;
        visibility: hidden; pointer-events: none; white-space: nowrap;
        padding: 6px 8px; border-radius: 3px;
        border: 1px solid var(--vscode-editorHoverWidget-border);
        background: var(--vscode-editorHoverWidget-background);
        color: var(--vscode-editorHoverWidget-foreground);
        box-shadow: 0 2px 8px var(--vscode-widget-shadow);
        font: var(--vscode-font-size, 13px) var(--vscode-font-family, sans-serif);
    }
    .viewer-session:not([data-tooltip-dismissed]):hover .viewer-session-tooltip,
    .viewer-session:not([data-tooltip-dismissed]):focus-visible .viewer-session-tooltip { visibility: visible; }
`;
