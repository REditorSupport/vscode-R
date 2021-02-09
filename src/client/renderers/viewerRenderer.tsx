const notebookApi = acquireNotebookRendererApi("r-notebook-table-renderer");


notebookApi.onDidCreateOutput((evt) => {
    const output = evt.output.data[evt.mimeType];
    evt.element.innerHTML =
});
