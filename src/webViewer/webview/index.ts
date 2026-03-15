import { acquireVsCodeApi, VsCode } from '../webviewMessages';

const vscode: VsCode = acquireVsCodeApi();

const replaceReg = /vscode-webview:\/\//;
const testReg = /vscode-webview:\/\/.*\.[A-Za-z/0-9_-]*?\/.+/;
const watchedTags = [
    'IMG',
    'A',
    'LINK',
    'SCRIPT'
];

function handleMutation(mutation: MutationRecord) {
    for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof HTMLElement) {
            if (watchedTags.includes(node.tagName)) {
                processElement(node);
            }
            node.querySelectorAll(watchedTags.join(',')).forEach(processElement);
        }
    }
}

function processElement(el: Element) {
    if (el instanceof HTMLImageElement || el instanceof HTMLScriptElement) {
        if (testReg.test(el.src)) {
            const newSrc = el.src.replace(replaceReg, 'https://');
            el.src = newSrc;
        }
    } else if (el instanceof HTMLAnchorElement || el instanceof HTMLLinkElement) {
        if (testReg.test(el.href)) {
            const newHref = el.href.replace(replaceReg, 'https://');
            el.href = newHref;
        }
    }
}

// Hijack links
function setupLinks() {
    const hyperLinks = document.getElementsByTagName('a');
    for (let i = 0; i < hyperLinks.length; i++) {
        const hrefAbs = hyperLinks[i].href;
        const hrefRel = hyperLinks[i].getAttribute('href') || '';

        if (hrefRel.startsWith('#')) {
            hyperLinks[i].onclick = () => {
                document.location.hash = hrefRel;
            };
        } else if (hrefAbs && hrefAbs.startsWith('vscode-webview://')) {
            hyperLinks[i].onclick = (ev) => {
                ev.preventDefault();
                vscode.postMessage({
                    message: 'linkClicked',
                    href: hrefAbs,
                    scrollY: window.scrollY
                });
            };
        }
    }
}

// Hijack mouse clicks
window.onmousedown = (ev) => {
    vscode.postMessage({
        message: 'mouseClick',
        button: Number(ev.button),
        scrollY: window.scrollY
    });
};

window.addEventListener('load', () => {
    setupLinks();

    const observer = new MutationObserver((mutations) => {
        mutations.forEach(handleMutation);
        setupLinks();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
});
