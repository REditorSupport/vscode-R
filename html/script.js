// the javascript file script.js is generated from script.ts
// used to communicate with vscode, can only be invoked once:
// @ts-ignore
var vscode = acquireVsCodeApi();
// notify vscode when mouse buttons are clicked
// used to implement back/forward on mouse buttons 3/4
window.onmousedown = function (ev) {
    vscode.postMessage({
        message: 'mouseClick',
        button: ev.button,
        scrollY: window.scrollY
    });
};
window.addEventListener('message', function (ev) {
    var message = ev.data;
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
window.document.body.onload = function () {
    var _a;
    // make relative path for hyperlinks
    var relPath = (document.body.getAttribute('relPath') || '');
    var loc = document.location;
    var url0 = new URL(loc.protocol + '//' + loc.host);
    var url1 = new URL(relPath, url0);
    // scroll to desired position:
    var scrollYTo = Number((_a = document.body.getAttribute('scrollYTo')) !== null && _a !== void 0 ? _a : -1);
    if (scrollYTo >= 0) {
        window.scrollTo(0, scrollYTo);
    }
    else if (url1.hash) {
        document.location.hash = url1.hash;
    }
    // notify vscode when links are clicked:
    var hyperLinks = document.getElementsByTagName('a');
    var _loop_1 = function (i) {
        var hrefAbs = hyperLinks[i].href;
        var hrefRel = hyperLinks[i].getAttribute('href') || '';
        if (hrefRel.startsWith('#')) {
            hyperLinks[i].onclick = function () {
                document.location.hash = hrefRel;
            };
        }
        else if (hrefAbs && hrefAbs.startsWith('vscode-webview://')) {
            hyperLinks[i].onclick = function () {
                var url2 = new URL(hrefRel, url1);
                var finalHref = url2.toString();
                vscode.postMessage({
                    message: 'linkClicked',
                    href: finalHref,
                    scrollY: window.scrollY
                });
            };
        }
    };
    for (var i = 0; i < hyperLinks.length; i++) {
        _loop_1(i);
    }
};
