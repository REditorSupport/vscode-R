// the javascript file script.js is generated from script.ts

// used to communicate with vscode, can only be invoked once:
// @ts-ignore
const vscode = acquireVsCodeApi(); 


// notify vscode when mouse buttons are clicked
// used to implement back/forward on mouse buttons 3/4
window.onmousedown = (ev) => {
    vscode.postMessage({
        message: 'mouseClick',
        button: ev.button,
        scrollY: window.scrollY
    });
};


// do everything after loading the body
window.document.body.onload = () => {

    // scroll to desired position:
    const scrollYTo = Number(document.body.getAttribute('scrollYTo')) || 0;
    window.scrollTo(0,scrollYTo);

    // make relative path for hyperlinks
    const relPath = document.body.getAttribute('relPath') || '';
    const relParts = relPath.split('/');

    // notify vscode when links are clicked:
    const hyperLinks = document.getElementsByTagName('a'); 

    for(let i=0; i<hyperLinks.length; i++){
        const href = hyperLinks[i].href;
        const title = hyperLinks[i].title;
        if(href && href.startsWith('vscode-webview://')){
            hyperLinks[i].onclick = () => { 

                // split urls into parts
                const hrefParts = href.split('/');
                const linkParts = title.split('/');

                // combine urls
                const newParts = hrefParts.slice(0, 3).concat(...relParts, ...linkParts);

                // resolve '..', '.'
                const finalParts = [];
                for(const newPart of newParts){
                    if(newPart === '..'){
                        finalParts.pop();
                    } else if(newPart==='.'){
                        // do nothing
                    } else{
                        finalParts.push(newPart);
                    }
                }

                const finalHref = finalParts.join('/');
                
                vscode.postMessage({
                    message: 'linkClicked',
                    href: finalHref,
                    scrollY: window.scrollY
                }); 
            };
        }
    }
};

