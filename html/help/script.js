/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-explicit-any */
const vscode = acquireVsCodeApi();
// notify vscode when mouse buttons are clicked
// used to implement back/forward on mouse buttons 3/4
window.onmousedown = (ev) => {
    vscode.postMessage({
        message: 'mouseClick',
        button: Number(ev.button),
        scrollY: window.scrollY
    });
};
// handle back/forward requests from vscode ui
// simulates a mousclick on key 3 or 4
window.addEventListener('message', (ev) => {
    const message = ev.data;
    if (message.command === 'goBack') {
        vscode.postMessage({
            message: 'mouseClick',
            button: 3,
            scrollY: window.scrollY
        });
    }
    else if (message.command === 'goForward') {
        vscode.postMessage({
            message: 'mouseClick',
            button: 4,
            scrollY: window.scrollY
        });
    }
});
// do everything after loading the body
window.document.body.onload = () => {
    var _a;
    // make relative path for hyperlinks
    const relPath = (document.body.getAttribute('relPath') || '');
    // notify vscode, used to restore help panels between sessions
    vscode.setState(relPath);
    const loc = document.location;
    const url0 = new URL(loc.protocol + '//' + loc.host);
    const url1 = new URL(relPath, url0);
    // scroll to desired position:
    const scrollYTo = Number((_a = document.body.getAttribute('scrollYTo')) !== null && _a !== void 0 ? _a : -1);
    if (scrollYTo >= 0) {
        window.scrollTo(0, scrollYTo);
    }
    else if (url1.hash) {
        document.location.hash = url1.hash;
    }
    // notify vscode when links are clicked:
    const hyperLinks = document.getElementsByTagName('a');
    for (let i = 0; i < hyperLinks.length; i++) {
        const hrefAbs = hyperLinks[i].href;
        const hrefRel = hyperLinks[i].getAttribute('href') || '';
        if (hrefRel.startsWith('#')) {
            hyperLinks[i].onclick = () => {
                document.location.hash = hrefRel;
            };
        }
        else if (hrefAbs && hrefAbs.startsWith('vscode-webview://')) {
            hyperLinks[i].onclick = () => {
                const url2 = new URL(hrefRel, url1);
                const finalHref = url2.toString();
                vscode.postMessage({
                    message: 'linkClicked',
                    href: finalHref,
                    scrollY: window.scrollY
                });
            };
        }
    }
};
