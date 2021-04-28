/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-explicit-any */
const vscode = acquireVsCodeApi();
// globals
let oldHeight = -1;
let oldWidth = -1;
const handler = document.querySelector('#handler');
const largePlotDiv = document.querySelector('#largePlot');
const cssLink = document.querySelector('link.overwrites');
const smallPlotDivs = [];
document.querySelectorAll('.plotDiv').forEach(elm => {
    smallPlotDivs.push(elm);
});
let isHandlerDragging = false;
function postResizeMessage(userTriggered = false) {
    const newHeight = largePlotDiv.clientHeight;
    const newWidth = largePlotDiv.clientWidth;
    if (newHeight !== oldHeight || newWidth !== oldWidth) {
        vscode.postMessage({
            message: 'resize',
            height: newHeight,
            width: newWidth,
            userTriggered: userTriggered
        });
        oldHeight = newHeight;
        oldWidth = newWidth;
    }
}
function postLogMessage(content) {
    console.log(content);
    vscode.postMessage({
        message: 'log',
        body: content
    });
}
window.addEventListener('message', (ev) => {
    const msg = ev.data;
    console.info(msg);
    if (msg.message === 'updatePlot') {
        updatePlot({
            id: String(msg.plotId),
            svg: msg.svg
        });
    }
    else if (msg.message === 'focusPlot') {
        console.log('focussing plot');
        focusPlot(String(msg.plotId));
    }
    else if (msg.message === 'toggleStyle') {
        toggleStyle(msg.useOverwrites);
    }
});
function focusPlot(plotId) {
    const ind = findIndex(plotId);
    if (ind < 0) {
        return false;
    }
    for (const elm of smallPlotDivs) {
        elm.classList.remove('active');
    }
    const smallPlotDiv = smallPlotDivs[ind];
    smallPlotDiv.classList.add('active');
    largePlotDiv.innerHTML = smallPlotDiv.innerHTML;
    return true;
}
function updatePlot(plt) {
    const ind = findIndex(plt.id);
    if (ind < 0) {
        return false;
    }
    smallPlotDivs[ind].innerHTML = plt.svg;
    if (smallPlotDivs[ind].classList.contains('active')) {
        console.log('active');
        largePlotDiv.innerHTML = plt.svg;
    }
    else {
        console.log('inactive');
    }
    return true;
}
function findIndex(plotId) {
    const ind = smallPlotDivs.findIndex(elm => elm.getAttribute('plotId') === plotId);
    if (ind < 0) {
        console.warn(`plotId not found: ${plotId}`);
    }
    return ind;
}
function toggleStyle(useOverwrites) {
    cssLink.disabled = !useOverwrites;
}
////
// Resize bar
////
document.addEventListener('mousedown', (e) => {
    // If mousedown event is fired from .handler, toggle flag to true
    if (e.target === handler) {
        isHandlerDragging = true;
        postLogMessage('mousedown');
        handler.classList.add('dragging');
        document.body.style.cursor = 'ns-resize';
    }
});
document.addEventListener('mousemove', (e) => {
    // Don't do anything if dragging flag is false
    if (!isHandlerDragging) {
        return false;
    }
    // postLogMessage('mousemove');
    // Get offset
    const containerOffsetTop = document.body.offsetTop;
    // Get x-coordinate of pointer relative to container
    const pointerRelativeYpos = e.clientY - containerOffsetTop;
    // Arbitrary minimum width set on box A, otherwise its inner content will collapse to width of 0
    const largePlotMinHeight = 60;
    // Resize large plot
    const newHeight = Math.max(largePlotMinHeight, pointerRelativeYpos - 5);
    const newHeightString = `${newHeight}px`;
    if (largePlotDiv.style.height !== newHeightString) {
        largePlotDiv.style.height = newHeightString;
        postResizeMessage();
    }
});
window.onresize = () => postResizeMessage();
document.addEventListener('mouseup', () => {
    // Turn off dragging flag when user mouse is up
    if (isHandlerDragging) {
        postResizeMessage(true);
        document.body.style.cursor = '';
    }
    handler.classList.remove('dragging');
    isHandlerDragging = false;
});
