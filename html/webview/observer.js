const reg = /vscode-webview:\/\//g;
const MutationObserver = window.MutationObserver || window.WebKitMutationObserver;

const observer = new MutationObserver(function (mutations) {
  for (const mut in mutations) {
    const targ = mutations[mut].target;
    if (reg.test(targ.src)) {
        const newSrc = targ.src.replace(reg, 'https://');
        console.log(`[VSC-R] ${targ.src} changed to ${newSrc}`);
        targ.src = newSrc;
    }
  }
});

observer.observe(document, {
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "href", "style", "class"]
});