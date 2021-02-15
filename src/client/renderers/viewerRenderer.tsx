const notebookApi = acquireNotebookRendererApi("r-notebook-viewer-renderer");


notebookApi.onDidCreateOutput((evt) => {
    const output = evt.output.data[evt.mimeType];
    const iframe = document.createElement("iframe");
    iframe.style.border = "0";
    iframe.style.width = "90vw"
    iframe.style.minHeight = "30vw"
    iframe.sandbox.add("allow-scripts");
    iframe.sandbox.add("allow-forms");
    iframe.sandbox.add("allow-same-origin");
    iframe.srcdoc = output
    evt.element.appendChild(iframe)
});
