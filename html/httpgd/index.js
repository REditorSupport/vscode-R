/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-explicit-any */
const vscode = acquireVsCodeApi();
let oldHeight = -1;
let oldWidth = -1;
function postResizeMessage(userTriggered = false) {
    const newHeight = svgDiv.clientHeight;
    const newWidth = svgDiv.clientWidth;
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
    if (msg.message === 'updatePlot' && msg.id === 'svg') {
        const elm = document.getElementById('svgDiv');
        const plotId = elm === null || elm === void 0 ? void 0 : elm.getAttribute('plotId');
        if (!elm || msg.plotId !== plotId) {
            return;
        }
        elm.innerHTML = msg.svg;
    }
});
////
// Resize bar
////
const handler = document.querySelector('#handler');
const wrapper = handler === null || handler === void 0 ? void 0 : handler.closest('#container');
const svgDiv = wrapper === null || wrapper === void 0 ? void 0 : wrapper.querySelector('#svgDiv');
let isHandlerDragging = false;
document.addEventListener('mousedown', (e) => {
    // If mousedown event is fired from .handler, toggle flag to true
    if (e.target === handler) {
        isHandlerDragging = true;
        postLogMessage('mousedown');
        handler.classList.add('dragging');
    }
});
document.addEventListener('mousemove', (e) => {
    // Don't do anything if dragging flag is false
    if (!isHandlerDragging) {
        return false;
    }
    // postLogMessage('mousemove');
    // Get offset
    const containerOffsetTop = wrapper === null || wrapper === void 0 ? void 0 : wrapper.offsetTop;
    // Get x-coordinate of pointer relative to container
    const pointerRelativeYpos = e.clientY - containerOffsetTop;
    // Arbitrary minimum width set on box A, otherwise its inner content will collapse to width of 0
    const boxAminHeight = 60;
    // Resize box A
    // * 8px is the left/right spacing between .handler and its inner pseudo-element
    // * Set flex-grow to 0 to prevent it from growing
    const newHeight = Math.max(boxAminHeight, pointerRelativeYpos - 5);
    const newHeightString = `${newHeight}px`;
    if (svgDiv.style.height !== newHeightString) {
        svgDiv.style.height = newHeightString;
        postResizeMessage();
    }
});
window.onresize = () => postResizeMessage();
document.addEventListener('mouseup', () => {
    // Turn off dragging flag when user mouse is up
    if (isHandlerDragging) {
        postResizeMessage(true);
    }
    handler.classList.remove('dragging');
    isHandlerDragging = false;
});
