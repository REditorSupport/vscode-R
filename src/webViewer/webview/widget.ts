import type { HtmlViewerPanelReference, VsCode } from '../webviewMessages';

export function initializeWidgetState(vscode: VsCode, state: HtmlViewerPanelReference): void {
    vscode.setState(state);
}

export function initializeWidgetLoad(vscode: VsCode, generation: number): void {
    // The webview HTML setter only queues a document replacement. Wait for
    // its resources and a paint before enabling navigation in the host.
    const loaded = () => requestAnimationFrame(() => requestAnimationFrame(() => {
        vscode.postMessage({ message: 'widget/loaded', generation });
    }));
    if (document.readyState === 'complete') { loaded(); }
    else { window.addEventListener('load', loaded, { once: true }); }
}

export function initializeWidgetContent(vscode: VsCode, generation: number, sessionOwned: boolean): void {
    document.addEventListener('click', event => {
        if (event.defaultPrevented) { return; }
        const anchor = event.target instanceof Element ? event.target.closest('a') : null;
        if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) { return; }
        const href = (anchor.getAttribute('href') ?? '').trim();
        if (href.startsWith('#')) {
            // The resource base is the output directory, so native fragment navigation
            // would leave this document. Resolve targets within the displayed document instead.
            event.preventDefault();
            let fragment = href.slice(1);
            try { fragment = decodeURIComponent(fragment); } catch { /* Keep malformed fragments literal. */ }
            const target = document.getElementById(fragment)
                ?? Array.from(document.getElementsByName(fragment)).find(element => element instanceof HTMLAnchorElement);
            if (target) { target.scrollIntoView(); }
            else if (!fragment || fragment.toLowerCase() === 'top') { window.scrollTo(0, 0); }
        } else if (/^(https?:|mailto:)/i.test(href)) {
            event.preventDefault();
            vscode.postMessage({ message: 'linkClicked', href: anchor.href });
        }
    });
    document.addEventListener('mousedown', event => {
        if (sessionOwned && (event.button === 3 || event.button === 4)) {
            event.preventDefault();
            vscode.postMessage({ message: 'widget/navigate', direction: event.button === 3 ? 'back' : 'forward', generation });
        }
    });
    document.addEventListener('keydown', event => {
        if (event.defaultPrevented) { return; }
        if (sessionOwned && event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            event.preventDefault();
            vscode.postMessage({ message: 'widget/navigate', direction: event.key === 'ArrowLeft' ? 'back' : 'forward', generation });
        } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
            event.preventDefault();
            vscode.postMessage({ message: 'widget/find', generation });
        }
    });
}
