
document.body.onload = () => {
    document.body.querySelectorAll('.httpgd circle').forEach(cl => {
        const child = document.createElement('title');
        child.innerText = 'Hello world!';
        cl.appendChild(child);
        cl.setAttribute('title', 'dummy');
        cl.innerHTML += '';
    })
}
