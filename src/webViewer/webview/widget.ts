// The sandboxed widget has no VS Code API; communicate only with its host frame.
document.addEventListener('click', event => {
    if (event.defaultPrevented) { return; }
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) { return; }
    const href = (anchor.getAttribute('href') ?? '').trim();
    if (href.startsWith('#')) {
        // The resource base is the output directory, so native fragment navigation
        // would leave this document. Resolve targets within the widget instead.
        event.preventDefault();
        let fragment = href.slice(1);
        try { fragment = decodeURIComponent(fragment); } catch { /* Keep malformed fragments literal. */ }
        const target = document.getElementById(fragment)
            ?? Array.from(document.getElementsByName(fragment)).find(element => element instanceof HTMLAnchorElement);
        if (target) { target.scrollIntoView(); }
        else if (!fragment || fragment.toLowerCase() === 'top') { window.scrollTo(0, 0); }
    } else if (/^(https?:|mailto:)/i.test(href)) {
        event.preventDefault();
        window.parent.postMessage({ message: 'widget/bridge', href: anchor.href }, '*');
    }
});
document.addEventListener('mousedown', event => {
    if (event.button === 3 || event.button === 4) {
        event.preventDefault();
        window.parent.postMessage({ message: 'widget/bridge', direction: event.button === 3 ? 'back' : 'forward' }, '*');
    }
});
document.addEventListener('keydown', event => {
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        window.parent.postMessage({ message: 'widget/bridge', direction: event.key === 'ArrowLeft' ? 'back' : 'forward' }, '*');
    }
});
