

// @ts-ignore
const vscode = acquireVsCodeApi(); 

let oldHeight = -1;
let oldWidth = -1;

function postResizeMessage(){
  const newHeight = svgDiv.clientHeight;
  const newWidth = svgDiv.clientWidth;
  if(newHeight !== oldHeight || newWidth !== oldWidth){
    vscode.postMessage({
      message: 'resize',
      height: newHeight,
      width: newWidth
    })
    oldHeight = newHeight;
    oldWidth = newWidth;
  }
}

interface Message {
  message: 'updatePlot',
  id: 'svg',
  svg: string
}

window.addEventListener('message', (ev: MessageEvent<Message>) => {
  const msg = ev.data;
  if(msg.message === 'updatePlot' && msg.id === 'svg'){
    const elm = document.getElementById('svgDiv');
    if(!elm){
      return;
    }
    elm.innerHTML = msg.svg;
  }
});


////
// Resize bar
////

const handler = document.querySelector('#handler') as HTMLDivElement;
const wrapper = handler?.closest('#container') as HTMLDivElement;
const svgDiv = wrapper?.querySelector('#svgDiv') as HTMLDivElement;
let isHandlerDragging = false;

document.addEventListener('mousedown', function(e) {
  // If mousedown event is fired from .handler, toggle flag to true
  if (e.target === handler) {
    isHandlerDragging = true;
  }
});

document.addEventListener('mousemove', function(e) {
  // Don't do anything if dragging flag is false
  if (!isHandlerDragging) {
    return false;
  }

  // Get offset
  const containerOffsetTop = wrapper?.offsetTop;

  // Get x-coordinate of pointer relative to container
  const pointerRelativeYpos = e.clientY - containerOffsetTop;
  
  // Arbitrary minimum width set on box A, otherwise its inner content will collapse to width of 0
  const boxAminHeight = 60;

  // Resize box A
  // * 8px is the left/right spacing between .handler and its inner pseudo-element
  // * Set flex-grow to 0 to prevent it from growing
  const newHeight = Math.max(boxAminHeight, pointerRelativeYpos - 5);
  const newHeightString = `${newHeight}px`;

  if(svgDiv.style.height !== newHeightString){
    svgDiv.style.height = newHeightString;
    svgDiv.style.flexGrow = '0';
    postResizeMessage();
  }
});

window.onresize = () => postResizeMessage();

document.addEventListener('mouseup', function(e) {
  // Turn off dragging flag when user mouse is up
  isHandlerDragging = false;
});

