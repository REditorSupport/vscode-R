
document.body.onload = () => {
    document.body.querySelectorAll('.httpgd circle').forEach(cl => {
        // append title-child that shows as tooltip:
        const child = document.createElement('title');
        child.innerText = 'Hello world!';
        cl.appendChild(child);
        
        // hacky way to trigger redraw of the image:
        cl.innerHTML += '';
    });
};
