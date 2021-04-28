/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-explicit-any */


interface Plot {
  // unique ID for this plot (w.r.t. this connection/device)
  id: string;

  // svg of the plot
  svg: string;
  
  heigth?: number;
  width?: number;
}

// get vscode api
declare function acquireVsCodeApi(): VsCode;
const vscode = acquireVsCodeApi();

// globals
let oldHeight = -1;
let oldWidth = -1;


const handler = document.querySelector('#handler') as HTMLDivElement;
const largePlotDiv = document.querySelector('#largePlot') as HTMLDivElement;
const cssLink = document.querySelector('link.overwrites') as HTMLLinkElement;
const smallPlotDiv = document.querySelector('#smallPlots') as HTMLDivElement;


function getSmallPlots(): Element[] {
  const smallPlots: Element[] = [];
  document.querySelectorAll('a.focusPlot').forEach(elm => {
    smallPlots.push(elm);
  });
  return smallPlots;
}

let isHandlerDragging = false;



function postResizeMessage(userTriggered: boolean = false){
  const newHeight = largePlotDiv.clientHeight;
  const newWidth = largePlotDiv.clientWidth;
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
  console.info(msg);
  if(msg.message === 'updatePlot'){
    updatePlot({
      id: String(msg.plotId),
      svg: msg.svg
    });
  } else if(msg.message === 'focusPlot'){
    console.log('focussing plot');
    focusPlot(String(msg.plotId));
  } else if(msg.message === 'toggleStyle'){
    toggleStyle(msg.useOverwrites);
  } else if(msg.message === 'hidePlot'){
    hidePlot(msg.plotId);
  } else if(msg.message === 'addPlot'){
    addPlot(msg.html);
  } else if(msg.message === 'toggleMultirow'){
    toggleMultirow(msg.useMultirow);
  }
});

function addPlot(html: string){
  const wrapper = document.createElement('div');
  wrapper.classList.add('wrapper');
  wrapper.innerHTML = html;
  smallPlotDiv.appendChild(wrapper);
}

function focusPlot(plotId: string): void {
  
  const smallPlots = getSmallPlots();

  const ind = findIndex(plotId, smallPlots);
  if(ind < 0){
    return;
  }

  for(const elm of smallPlots){
    elm.classList.remove('active');
  }
  
  const smallPlotDiv = smallPlots[ind];
  const smallPlotContent = smallPlots[ind];

  smallPlotDiv.classList.add('active');
  
  largePlotDiv.innerHTML = smallPlotContent.innerHTML;
}

function updatePlot(plt: Plot): void {
  
  const smallPlots = getSmallPlots();

  const ind = findIndex(plt.id, smallPlots);
  if(ind<0){
    return;
  }
  
  smallPlots[ind].innerHTML = plt.svg;
  
  if(smallPlots[ind].classList.contains('active')){
    largePlotDiv.innerHTML = plt.svg;
  }
}

function hidePlot(plotId: string): void {
  const smallPlots = getSmallPlots();

  const ind = findIndex(plotId, smallPlots);
  if(ind<0){
    return;
  }
  
  if(smallPlots[ind].classList.contains('active')){
    largePlotDiv.innerHTML = '';
  }
  
  smallPlots[ind].parentElement?.remove();
}

function findIndex(plotId: string, smallPlots?: Element[]): number {
  smallPlots ||= getSmallPlots();
  const ind = smallPlots.findIndex(elm => elm.getAttribute('plotId') === String(plotId));
  if(ind<0){
    console.warn(`plotId not found: ${plotId}`);
  }
  return ind;
}

function toggleStyle(useOverwrites: boolean): void {
  cssLink.disabled = !useOverwrites;
}

function toggleMultirow(useMultirow: boolean): void {
  if(useMultirow){
    smallPlotDiv.classList.add('multirow');
  } else{
    smallPlotDiv.classList.remove('multirow');
  }
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

  if(largePlotDiv.style.height !== newHeightString){
    largePlotDiv.style.height = newHeightString;
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

