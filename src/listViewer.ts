export interface ListViewNavigation {
    title: string;
    path: number[];
    breadcrumbs: { label: string; path: number[] }[];
}

/** Script shared by the list webview and its interaction tests. */
export function getListViewerScript(generation: number, initial: ListViewNavigation = {
    title: '', path: [], breadcrumbs: [{ label: '', path: [] }],
}): string {
    return `
    const vscode = acquireVsCodeApi();
    const generation = ${generation};
    const pending = new Map();
    let nextRequestId = 0;
    const list = document.getElementById('list');
    const back = document.getElementById('back');
    const breadcrumbs = document.getElementById('breadcrumbs');
    const navigationStatus = document.getElementById('navigation-status');
    const pages = new Map();
    const history = [];
    let current;
    let navigating = false;

    function showNavigation(navigation, goingBack = false) {
        const key = JSON.stringify(navigation.path);
        if (current) {
            pages.get(JSON.stringify(current.path)).scrollTop = list.scrollTop;
            if (goingBack) history.pop();
            else if (JSON.stringify(current.path) !== key) history.push(current);
        }
        current = navigation;
        let page = pages.get(key);
        if (!page) {
            const element = document.createElement('div');
            page = { element, scrollTop: 0, loader: createPage(element, navigation.path) };
            pages.set(key, page);
        }
        list.replaceChildren(page.element);
        list.scrollTop = page.scrollTop;
        back.disabled = history.length === 0;
        breadcrumbs.replaceChildren();
        navigation.breadcrumbs.forEach((crumb, index) => {
            if (index) {
                const separator = document.createElement('span');
                separator.className = 'breadcrumb-separator';
                separator.setAttribute('aria-hidden', 'true');
                breadcrumbs.appendChild(separator);
            }
            const isCurrent = index === navigation.breadcrumbs.length - 1;
            const item = document.createElement(isCurrent ? 'span' : 'button');
            item.className = 'breadcrumb';
            item.textContent = crumb.label;
            item.title = crumb.label;
            if (isCurrent) item.setAttribute('aria-current', 'page');
            else item.addEventListener('click', () => navigate('listview/navigate', { path: crumb.path }));
            breadcrumbs.appendChild(item);
        });
        page.loader.loadOnce();
    }

    function navigate(message, params, goingBack = false) {
        if (navigating) return;
        navigating = true;
        navigationStatus.textContent = '';
        const requestId = ++nextRequestId;
        pending.set(requestId, (response) => {
            navigating = false;
            if (response.error) {
                navigationStatus.textContent = response.error;
            } else if (response.navigation) {
                showNavigation(response.navigation, goingBack);
            }
        });
        vscode.postMessage({ message, generation, requestId, ...params });
    }

    back.addEventListener('click', () => {
        if (history.length) navigate('listview/navigate', { path: history[history.length - 1].path }, true);
    });

    function createPage(container, path) {
        const rows = document.createElement('div');
        const more = document.createElement('button');
        more.className = 'load-more';
        more.textContent = 'Load more';
        const status = document.createElement('div');
        status.setAttribute('role', 'status');
        container.appendChild(rows);
        container.appendChild(more);
        container.appendChild(status);
        let nextStart = 1;
        let loading = false;
        let loaded = false;

        function loadPage() {
            if (loading || nextStart === null) return;
            loading = true;
            more.disabled = true;
            more.textContent = 'Loading…';
            status.textContent = '';
            const requestId = ++nextRequestId;
            pending.set(requestId, (message) => {
                loading = false;
                more.disabled = false;
                if (message.error) {
                    status.textContent = message.error;
                    more.textContent = 'Retry';
                    return;
                }
                loaded = true;
                for (const item of message.children) {
                    const expandable = item.has_children;
                    const entry = document.createElement(expandable ? 'details' : 'div');
                    const row = document.createElement(expandable ? 'summary' : 'div');
                    row.className = 'item';
                    const arrow = document.createElement('span');
                    arrow.className = 'arrow';
                    arrow.setAttribute('aria-hidden', 'true');
                    row.appendChild(arrow);
                    const label = document.createElement('span');
                    label.className = 'label';
                    label.textContent = item.label;
                    row.appendChild(label);
                    const str = document.createElement('span');
                    str.className = 'str';
                    str.textContent = item.str;
                    row.appendChild(str);

                    if (item.viewable) {
                        const button = document.createElement('button');
                        button.title = 'View';
                        button.setAttribute('aria-label', 'View ' + item.label);
                        button.innerHTML = document.getElementById('view-icon').innerHTML;
                        button.addEventListener('click', (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            navigate('listview/view', { path, index: item.index });
                        });
                        row.appendChild(button);
                    }
                    entry.appendChild(row);
                    if (expandable) {
                        const children = document.createElement('div');
                        children.className = 'children';
                        entry.appendChild(children);
                        const page = createPage(children, [...path, item.index]);
                        entry.addEventListener('toggle', () => {
                            if (entry.open) page.loadOnce();
                        });
                    }
                    rows.appendChild(entry);
                }
                nextStart = message.next_start ?? null;
                more.hidden = nextStart === null;
                more.textContent = 'Load more';
                status.textContent = rows.childElementCount ? '' : 'No items';
            });
            vscode.postMessage({ message: 'listview/page', generation, requestId, path, start: nextStart });
        }
        more.addEventListener('click', loadPage);
        return { loadOnce: () => { if (!loaded) loadPage(); } };
    }

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (!['listview/page', 'listview/navigation'].includes(message.message) || message.generation !== generation) return;
        const receive = pending.get(message.requestId);
        if (receive) {
            pending.delete(message.requestId);
            receive(message);
        }
    });
    showNavigation(${JSON.stringify(initial).replace(/</g, '\\u003c')});
    `;
}
