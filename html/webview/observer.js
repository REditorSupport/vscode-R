const reg = /vscode-webview:\/\//g;
const MutationObserver = window.MutationObserver || window.WebKitMutationObserver;

const observer = new MutationObserver(function (mutations) {
  const len = mutations.length;
  for (let i = 0; i < len; i++) {
    const targ = mutations[i].target;
    if (reg.test(targ.src)) {
        const newSrc = targ.src.replace(reg, 'https://');
        console.log(`[VSC-R] ${targ.src} changed to ${newSrc}`);
        targ.src = newSrc;
    }
  }
});

observer.observe(document.getElementById("webview-content"), {
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "href", "style", "class"],
});
