/// <reference lib="dom" />

import { viewerSessionStyle } from './viewerSession';

export interface ListViewNavigation {
    title: string;
    path: number[];
    breadcrumbs: { label: string; path: number[] }[];
    /** Row presentation at this path; lists and vectors share the same viewer. */
    vector?: boolean;
}

export interface ListViewPage {
    children: { label: string; str: string; index: number; viewable?: boolean; has_children?: boolean }[];
    next_start?: number | null;
}
export interface ListViewReply extends Partial<ListViewPage> {
    requestId: number;
    error?: string;
    navigation?: ListViewNavigation;
}
export interface ListViewer {
    reply(message: ListViewReply): void;
    dispose(): void;
    navigation(): ListViewNavigation;
}

/** Shared tree, paging and navigation for the panel and Interactive cells. */
export function createListViewer(
    { root, list, back, reset, breadcrumbs, navigationStatus }: {
        root: HTMLElement; list: HTMLElement; back: HTMLButtonElement; reset: HTMLButtonElement;
        breadcrumbs: HTMLElement; navigationStatus: HTMLElement;
    },
    initial: ListViewNavigation,
    request: (message: { message: string; path: number[]; index?: number; start?: number }) => number,
    initialPage?: ListViewPage,
    live = true,
): ListViewer {
    const pending = new Map<number, (message: ListViewReply) => void>();
    const pages = new Map<string, { element: HTMLElement; scrollTop: number; loader: { loadOnce(): void } }>();
    const history: ListViewNavigation[] = [];
    let current: ListViewNavigation | undefined;
    let navigating = false;
    let disposed = false;
    function showNavigation(navigation: ListViewNavigation, goingBack = false): void {
        const key = JSON.stringify(navigation.path);
        if (current) {
            pages.get(JSON.stringify(current.path))!.scrollTop = list.scrollTop;
            if (goingBack) { history.pop(); }
            else if (JSON.stringify(current.path) !== key) { history.push(current); }
        }
        current = navigation;
        root.classList.toggle('vector', !!navigation.vector);
        let page = pages.get(key);
        if (!page) {
            const element = document.createElement('div');
            page = { element, scrollTop: 0, loader: createPage(element, navigation.path, navigation.vector, pages.size === 0 ? initialPage : undefined) };
            pages.set(key, page);
        }
        list.replaceChildren(page.element);
        list.scrollTop = page.scrollTop;
        back.disabled = !live || history.length === 0;
        reset.disabled = !live;
        breadcrumbs.replaceChildren();
        navigation.breadcrumbs.forEach((crumb, index) => {
            if (index) {
                const separator = document.createElement('span');
                separator.className = 'codicon codicon-chevron-right';
                separator.setAttribute('aria-hidden', 'true');
                breadcrumbs.appendChild(separator);
            }
            const isCurrent = index === navigation.breadcrumbs.length - 1;
            const item = document.createElement(isCurrent ? 'span' : 'button');
            item.className = 'breadcrumb';
            item.textContent = crumb.label;
            item.title = crumb.label;
            if (isCurrent) { item.setAttribute('aria-current', 'page'); }
            else {
                (item as HTMLButtonElement).disabled = !live;
                item.addEventListener('click', () => navigate('listview/navigate', { path: crumb.path }));
            }
            breadcrumbs.appendChild(item);
        });
        page.loader.loadOnce();
    }

    function navigate(message: string, params: { path: number[]; index?: number }, goingBack = false, resetting = false): void {
        if (disposed || !live || navigating) { return; }
        navigating = true;
        navigationStatus.textContent = '';
        const requestId = request({ message, ...params });
        pending.set(requestId, (response) => {
            navigating = false;
            if (response.error) {
                navigationStatus.textContent = response.error;
            } else if (response.navigation) {
                if (resetting) {
                    pending.clear(); pages.clear(); history.length = 0; current = undefined;
                }
                showNavigation(response.navigation, goingBack);
            }
        });
    }

    back.addEventListener('click', () => {
        if (history.length) { navigate('listview/navigate', { path: history[history.length - 1].path }, true); }
    });
    reset.addEventListener('click', () => navigate('listview/navigate', { path: initial.path }, false, true));

    function createPage(container: HTMLElement, path: number[], vector = false, savedPage?: ListViewPage): { loadOnce(): void } {
        const rows = document.createElement('div');
        const more = document.createElement('button');
        more.className = 'load-more';
        more.textContent = 'Load more';
        const status = document.createElement('div');
        status.setAttribute('role', 'status');
        container.appendChild(rows);
        container.appendChild(more);
        container.appendChild(status);
        let nextStart: number | null = 1;
        let loading = false;
        let loaded = false;

        function loadPage(): void {
            if (disposed || (!live && !savedPage) || loading || nextStart === null) { return; }
            loading = true;
            more.disabled = true;
            more.textContent = 'Loading…';
            status.textContent = '';
            const receive = (message: ListViewReply): void => {
                loading = false;
                more.disabled = !live;
                if (message.error) {
                    status.textContent = message.error;
                    more.textContent = 'Retry';
                    return;
                }
                loaded = true;
                for (const item of message.children ?? []) {
                    const expandable = item.has_children;
                    const entry = document.createElement(expandable ? 'details' : 'div');
                    const row = document.createElement(expandable ? 'summary' : 'div');
                    row.className = 'item';
                    if (!vector) {
                        const arrow = document.createElement('span');
                        arrow.className = expandable ? 'arrow codicon codicon-chevron-right' : 'arrow';
                        arrow.setAttribute('aria-hidden', 'true');
                        row.appendChild(arrow);
                    }
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
                        button.disabled = !live;
                        button.setAttribute('aria-label', 'View ' + item.label);
                        const icon = document.createElement('span');
                        icon.className = 'codicon codicon-open-preview';
                        icon.setAttribute('aria-hidden', 'true');
                        button.appendChild(icon);
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
                        let page: { loadOnce(): void } | undefined;
                        entry.addEventListener('toggle', () => {
                            if ((entry as HTMLDetailsElement).open && !live && !page) { (entry as HTMLDetailsElement).open = false; return; }
                            if ((entry as HTMLDetailsElement).open) {
                                page ??= createPage(children, [...path, item.index]);
                                page.loadOnce();
                            }
                        });
                    }
                    rows.appendChild(entry);
                }
                nextStart = message.next_start ?? null;
                more.hidden = nextStart === null;
                more.textContent = 'Load more';
                status.textContent = rows.childElementCount ? '' : 'No items';
            };
            if (savedPage) {
                const page = savedPage; savedPage = undefined; receive({ ...page, requestId: 0 });
            } else {
                pending.set(request({ message: 'listview/page', path, start: nextStart }), receive);
            }
        }
        more.addEventListener('click', loadPage);
        return { loadOnce: () => { if (!loaded) { loadPage(); } } };
    }

    showNavigation(initial);
    return {
        navigation: () => current!,
        reply(message) {
            const receive = pending.get(message.requestId);
            if (receive) { pending.delete(message.requestId); receive(message); }
        },
        dispose() { disposed = true; pending.clear(); },
    };
}

/** Panel wrapper and its interaction tests. Keep panel focus/blur hooks here. */
export function getListViewerScript(documentGeneration: number, initial: ListViewNavigation = {
    title: '', path: [], breadcrumbs: [{ label: '', path: [] }],
}): string {
    return `
    const vscode = acquireVsCodeApi();
    const documentGeneration = ${documentGeneration};
    let nextRequestId = 0;
    const viewer = (${createListViewer.toString()})({
        root: document.body, list: document.getElementById('list'), back: document.getElementById('back'), reset: document.getElementById('reset'),
        breadcrumbs: document.getElementById('breadcrumbs'), navigationStatus: document.getElementById('navigation-status'),
    }, ${JSON.stringify(initial).replace(/</g, '\\u003c')}, message => {
        const requestId = ++nextRequestId;
        vscode.postMessage({ ...message, documentGeneration, requestId });
        return requestId;
    });
    window.addEventListener('message', event => {
        const message = event.data;
        if (['listview/page', 'listview/navigation'].includes(message.message) && message.documentGeneration === documentGeneration) viewer.reply(message);
    });
    `;
}

export const listViewerStyle = `
    .r-list-viewer .list { flex: 1; min-height: 0; overflow: auto; }
    .r-list-viewer .navigation {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 6px 8px;
        min-height: 28px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--vscode-breadcrumb-background, var(--vscode-editor-background));
    }
    .r-list-viewer .back { gap: 4px; padding: 4px 6px; flex-shrink: 0; border-radius: 3px; }
    .r-list-viewer .back:disabled { opacity: 0.4; cursor: default; background: transparent; }
    .r-list-viewer .reset { gap: 4px; padding: 4px 6px; flex-shrink: 0; border-radius: 3px; }
    ${viewerSessionStyle}
    .r-list-viewer .viewer-session { margin-left: auto; }
    .r-list-viewer .codicon { flex-shrink: 0; }
    .r-list-viewer .breadcrumbs {
        display: flex;
        align-items: center;
        gap: 2px;
        overflow-x: auto;
        color: var(--vscode-breadcrumb-foreground);
    }
    .r-list-viewer .breadcrumb { padding: 4px; white-space: nowrap; border-radius: 3px; }
    .r-list-viewer button.breadcrumb:hover { color: var(--vscode-breadcrumb-focusForeground); }
    .r-list-viewer .breadcrumb[aria-current] { color: var(--vscode-breadcrumb-activeSelectionForeground); }
    .r-list-viewer .navigation-status { padding: 0 8px; color: var(--vscode-errorForeground); }
    .r-list-viewer .item {
        display: flex;
        align-items: center;
        gap: 12px;
        min-height: 28px;
        padding: 2px 8px;
    }
    .r-list-viewer .item:hover {
        background-color: var(--vscode-list-hoverBackground);
        color: var(--vscode-list-hoverForeground);
    }
    .r-list-viewer summary.item { cursor: pointer; list-style: none; }
    .r-list-viewer summary.item::-webkit-details-marker { display: none; }
    .r-list-viewer .arrow { width: 16px; height: 16px; flex-shrink: 0; }
    .r-list-viewer summary > .arrow {
        color: var(--vscode-icon-foreground, currentColor);
    }
    .r-list-viewer details[open] > summary > .arrow { transform: rotate(90deg); }
    .r-list-viewer .children { margin-left: 24px; }
    .r-list-viewer button:focus-visible, .r-list-viewer summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
    .r-list-viewer .label {
        min-width: 140px;
        color: var(--vscode-symbolIcon-fieldForeground);
        white-space: nowrap;
    }
    .r-list-viewer.vector .label {
        min-width: 64px;
    }
    .r-list-viewer.vector .item {
        gap: 8px;
    }
    .r-list-viewer .str {
        flex: 1;
        color: var(--vscode-descriptionForeground);
        white-space: pre-wrap;
    }
    .r-list-viewer button {
        display: flex;
        align-items: center;
        border: 0;
        padding: 2px;
        color: var(--vscode-foreground);
        background: transparent;
        cursor: pointer;
        font: inherit;
    }
    .r-list-viewer button:hover {
        background-color: var(--vscode-toolbar-hoverBackground);
    }
    .r-list-viewer .load-more {
        margin: 8px;
    }
    .r-list-viewer .load-more[hidden] {
        display: none;
    }
`;
