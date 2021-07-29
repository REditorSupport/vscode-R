const reg = /vscode-webview:\/\//g;

/* eslint-disable */
const MutationObserver = window.MutationObserver || window.WebKitMutationObserver;
const observer = new MutationObserver(function(mutations, observer) {
  for (const mut in mutations) {
    const targ = mutations[mut].target;
    if (targ.src) {
      if (reg.test(targ.src)) {
        targ.src = targ.src.replace(reg, 'https://')
          }
        }
      }
    });

// define what element should be observed by the observer
// and what types of mutations trigger the callback
observer.observe(document, {
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "href", "style", "class"]
});