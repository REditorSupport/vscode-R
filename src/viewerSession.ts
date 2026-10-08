// Shared by the standalone list and data viewers.
export function formatSessionLabel(version: string, pid: string): string {
    const normalized = version.replace(/^R (?:version )?/, '').replace(/\s+\(.*/, '');
    return `R ${normalized}: ${pid}`;
}

export function getViewerSessionScript(): string {
    return `
    window.addEventListener('message', event => {
        const message = event.data;
        if (message?.message !== 'viewer-session/update' || typeof message.text !== 'string') { return; }
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
    `;
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
