document.body.onload = function () {
    document.body.querySelectorAll('.httpgd circle').forEach(function (cl) {
        var child = document.createElement('title');
        child.innerText = 'Hello world!';
        cl.appendChild(child);
        cl.setAttribute('title', 'dummy');
        cl.innerHTML += '';
    });
};
