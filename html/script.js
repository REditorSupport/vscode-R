// the javascript file script.js is generated from script.ts
var __spreadArrays = (this && this.__spreadArrays) || function () {
    for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
    for (var r = Array(s), k = 0, i = 0; i < il; i++)
        for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++)
            r[k] = a[j];
    return r;
};
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
// do everything after loading the body
window.document.body.onload = function () {
    // scroll to desired position:
    var scrollYTo = Number(document.body.getAttribute('scrollYTo')) || 0;
    window.scrollTo(0, scrollYTo);
    // make relative path for hyperlinks
    var relPath = document.body.getAttribute('relPath') || '';
    var relParts = relPath.split('/');
    // notify vscode when links are clicked:
    var hyperLinks = document.getElementsByTagName('a');
    var _loop_1 = function (i) {
        var href = hyperLinks[i].href;
        var title = hyperLinks[i].title;
        if (href && href.startsWith('vscode-webview://')) {
            hyperLinks[i].onclick = function () {
                var _a;
                // split urls into parts
                var hrefParts = href.split('/');
                var linkParts = title.split('/');
                // combine urls
                var newParts = (_a = hrefParts.slice(0, 3)).concat.apply(_a, __spreadArrays(relParts, linkParts));
                // resolve '..', '.'
                var finalParts = [];
                for (var _i = 0, newParts_1 = newParts; _i < newParts_1.length; _i++) {
                    var newPart = newParts_1[_i];
                    if (newPart === '..') {
                        finalParts.pop();
                    }
                    else if (newPart === '.') {
                        // do nothing
                    }
                    else {
                        finalParts.push(newPart);
                    }
                }
                var finalHref = finalParts.join('/');
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
