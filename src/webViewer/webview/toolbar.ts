import type { VsCode } from '../webviewMessages';

export function initializeWidgetToolbar(vscode: VsCode): void {
    const toolbar = document.getElementById('widget-toolbar');
    if (!toolbar) { return; }
    const back = document.getElementById('widget-back') as HTMLButtonElement;
    const forward = document.getElementById('widget-forward') as HTMLButtonElement;
    const remove = document.getElementById('widget-remove') as HTMLButtonElement;
    const frame = document.getElementById('widget-frame') as HTMLIFrameElement;
    if (frame.dataset.widgetDocument) {
        const html = frame.dataset.widgetDocument;
        delete frame.dataset.widgetDocument;
        let written = false;
        frame.addEventListener('load', () => {
            if (written || !frame.contentDocument || !frame.contentDocument.location.pathname.endsWith('/fake.html')) { return; }
            written = true;
            frame.contentDocument.open();
            frame.contentDocument.write(html);
            frame.contentDocument.close();
        });
        // srcdoc cannot load VS Code resources through its service worker.
        // Use VS Code's empty frame on the same origin, retaining its webview ID.
        const host = new URL(window.location.href);
        const bootstrap = new URL('fake.html', host);
        bootstrap.searchParams.set('id', host.searchParams.get('id') ?? '');
        if (host.searchParams.has('vscode-coi')) { bootstrap.searchParams.set('vscode-coi', host.searchParams.get('vscode-coi')!); }
        frame.src = bootstrap.toString();
    }
    const lockControls = () => { back.disabled = true; forward.disabled = true; remove.disabled = true; };
    const navigate = (direction: 'back' | 'forward') => {
        if ((direction === 'back' ? back : forward).disabled) { return; }
        lockControls();
        vscode.postMessage({ message: 'widget/navigate', direction, generation: Number(toolbar.dataset.generation) });
    };
    back.onclick = () => navigate('back');
    forward.onclick = () => navigate('forward');
    remove.onclick = () => {
        if (remove.disabled) { return; }
        lockControls();
        vscode.postMessage({ message: 'widget/remove', generation: Number(toolbar.dataset.generation) });
    };
    const keydown = (event: KeyboardEvent) => {
        if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            event.preventDefault();
            navigate(event.key === 'ArrowLeft' ? 'back' : 'forward');
        }
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('mousedown', event => {
        if (event.button === 3 || event.button === 4) {
            event.preventDefault(); navigate(event.button === 3 ? 'back' : 'forward');
        }
    });
    window.addEventListener('message', event => {
        if (event.source !== frame.contentWindow) { return; }
        const message: unknown = event.data;
        if (!message || typeof message !== 'object' || !('message' in message) || message.message !== 'widget/bridge') { return; }
        if ('direction' in message && (message.direction === 'back' || message.direction === 'forward')) {
            navigate(message.direction);
        } else if ('href' in message && typeof message.href === 'string' && /^(https?:|mailto:)/i.test(message.href)) {
            vscode.postMessage({ message: 'linkClicked', href: message.href, scrollY: 0 });
        }
    });
}
