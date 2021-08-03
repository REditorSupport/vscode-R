const MutationObserver = window.MutationObserver || window.WebKitMutationObserver;
const replaceReg = /vscode-webview:\/\//;
const testReg = /vscode-webview:\/\/.*\.[A-Za-z/0-9_-]*?\/.+/;
const watchedTags = [
  "IMG",
  "A",
  "LINK",
  "SCRIPT"
];
const mutationQueue = [];

const observer = new MutationObserver(mutations => {
  if (!mutationQueue.length) {
    requestAnimationFrame(setSrc);
  }
  mutationQueue.push(mutations);
});

observer.observe(document.getElementById("webview-content"), {
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "href", "style", "class"],
  characterData: false
});

function setSrc() {
  for (const mutations of mutationQueue) {
    const targ = mutations[0].target;
    if (watchedTags.includes(targ.tagName) && testReg.test(targ.src)) {
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
  mutationQueue.length = 0;
}
