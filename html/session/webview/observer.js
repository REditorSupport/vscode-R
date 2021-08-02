const MutationObserver = window.MutationObserver || window.WebKitMutationObserver;
const replaceReg = /vscode-webview:\/\//g;
const testReg = /vscode-webview:\/\/.*\.[A-Za-z/0-9]*?\/[A-Za-z/0-9]+/;

const observer = new MutationObserver(mutations => {
  const len = mutations.length;
  for (let i = 0; i < len; i++) {
    const targ = mutations[i].target;
    if (testReg.test(targ.src)) {
      const newSrc = targ.src.replace(replaceReg, 'https://');
      console.log(
        `%c[VSC-R] %cThe file request '${targ.src}' was converted to the URL '${newSrc}'. Reason: the request appears to refer to a URL, not a local file as suggested by the file scheme. %cIf you believe this to be in error, please log an issue on GitHub.`,
        "color: orange",
        "color: inherit",
        "font-style: italic"
      );
      targ.src = newSrc;
    }
  }
});

observer.observe(document.getElementById("webview-content"), {
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "href", "style", "class"],
  characterData: false
});
