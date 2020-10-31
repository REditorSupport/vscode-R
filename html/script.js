
// used to communicate with vscode, can only be invoked once:
const vscode = acquireVsCodeApi(); 


// notify vscode when links are clicked:
var hyperLinks = document.getElementsByTagName("a"); 

for(var i=0; i<hyperLinks.length; i++){
    const href = hyperLinks[i].href;
    console.log(' href: ' + href);
    hyperLinks[i].onclick = () => { 
        vscode.postMessage({
            message: 'linkClicked',
            href: href
        }); 
    };
}

// notify vscode when mouse buttons are clicked
// used to implement back/forward on mouse buttons 3/4
window.onmousedown = (ev) => {
    vscode.postMessage({
        message: 'mouseClick',
        button: ev.button
    });
};

