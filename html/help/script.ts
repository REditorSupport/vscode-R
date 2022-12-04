declare function acquireVsCodeApi(): VsCode;

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


// handle requests from vscode ui
window.addEventListener('message', (ev: MessageEvent) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const message = ev.data;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if(message.command === 'getScrollY'){
        vscode.postMessage({
            message: 'getScrollY',
            scrollY: window.scrollY
        });
    }
});


// do everything after loading the body
window.document.body.onload = () => {

    // make relative path for hyperlinks
    const relPath = (document.body.getAttribute('relPath') || '');

    // notify vscode, used to restore help panels between sessions
    vscode.setState(relPath);

    const loc = document.location;
    const url0 = new URL(loc.protocol + '//' + loc.host);
    const url1 = new URL(relPath, url0);

    // scroll to desired position:
    const scrollYTo = Number(document.body.getAttribute('scrollYTo') ?? -1);
    if(scrollYTo >= 0){
        window.scrollTo(0,scrollYTo);
    } else if(url1.hash){
        document.location.hash = url1.hash;
    }

    // notify vscode when links are clicked:
    const hyperLinks = document.getElementsByTagName('a');

    for(let i=0; i<hyperLinks.length; i++){
        const hrefAbs = hyperLinks[i].href;
        const hrefRel = hyperLinks[i].getAttribute('href') || '';

        if(hrefRel.startsWith('#')){
            hyperLinks[i].onclick = () => {
                document.location.hash = hrefRel;
            };
        } else if(hrefAbs && hrefAbs.startsWith('vscode-webview://')){
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

    // notify vscode when code is clicked:
    if(document.body.classList.contains('preClickable')){
        const codeElements = document.getElementsByTagName('pre');
        for(let i=0; i<codeElements.length; i++){
            const el = codeElements[i];
            el.onclick = (me: MouseEvent) => {
                vscode.postMessage({
                    message: 'codeClicked',
                    code: el.textContent || '',
                    modifiers: {
                        altKey: me.altKey,
                        ctrlKey: me.ctrlKey,
                        shiftKey: me.shiftKey,
                        metaKey: me.metaKey,
                    }
                });
            };
        }
    }
};

