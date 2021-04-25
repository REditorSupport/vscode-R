/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-explicit-any */



// postulate existence of vscode to tsc:
declare function acquireVsCodeApi(): VsCode;


const vscode = acquireVsCodeApi();

let oldHeight = -1;
let oldWidth = -1;

function postResizeMessage(userTriggered: boolean = false){
  const newHeight = svgDiv.clientHeight;
  const newWidth = svgDiv.clientWidth;
  if(newHeight !== oldHeight || newWidth !== oldWidth){
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

function postLogMessage(content: any){
  console.log(content);
  vscode.postMessage({
    message: 'log',
    body: content
  });
}

window.addEventListener('message', (ev: MessageEvent<InMessage>) => {
  const msg = ev.data;
  if(msg.message === 'updatePlot' && msg.id === 'svg'){
    const elm = document.getElementById('largePlot');
    const plotId = elm?.getAttribute('plotId');
    if(!elm || msg.plotId !== plotId){
      return;
    }
    elm.innerHTML = msg.svg;
  }
});


////
// Resize bar
////

const handler = document.querySelector('#handler') as HTMLDivElement;
const svgDiv = document.querySelector('#largePlot') as HTMLDivElement;
let isHandlerDragging = false;

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

  if(svgDiv.style.height !== newHeightString){
    svgDiv.style.height = newHeightString;
    postResizeMessage();
  }
});

window.onresize = () => postResizeMessage();

document.addEventListener('mouseup', () => {
  // Turn off dragging flag when user mouse is up
  if(isHandlerDragging){
    postResizeMessage(true);
    document.body.style.cursor = '';
  }
  handler.classList.remove('dragging');
  isHandlerDragging = false;
});

