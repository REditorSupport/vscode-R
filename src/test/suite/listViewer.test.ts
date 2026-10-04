import * as assert from 'assert';
import * as vm from 'vm';
import { getListViewerScript, ListViewNavigation } from '../../listViewer';

// Minimal DOM surface for exercising the actual webview script and its RPCs.
class Element {
    children: Element[] = [];
    listeners = new Map<string, (event: unknown) => void>();
    textContent = '';
    innerHTML = '';
    className = '';
    hidden = false;
    disabled = false;
    open = false;
    scrollTop = 0;
    constructor(readonly tag: string) { }
    get childElementCount(): number { return this.children.length; }
    appendChild(child: Element): void { this.children.push(child); }
    replaceChildren(...children: Element[]): void { this.children = children; }
    setAttribute(): void { /* Attributes do not affect these interaction tests. */ }
    addEventListener(type: string, listener: (event: unknown) => void): void {
        this.listeners.set(type, listener);
    }
    fire(type: string, event: unknown = {}): void { this.listeners.get(type)?.(event); }
}

interface Request {
    message: string;
    documentGeneration: number;
    requestId: number;
    path: number[];
    index?: number;
    start?: number;
}

function createViewer(initial: ListViewNavigation = {
    title: 'x', path: [], breadcrumbs: [{ label: 'x', path: [] }],
}) {
    const root = new Element('div');
    const back = new Element('button');
    const breadcrumbs = new Element('nav');
    const status = new Element('div');
    const bodyClasses = new Set<string>();
    const elements: Record<string, Element> = { list: root, back, breadcrumbs, 'navigation-status': status };
    const messages: Request[] = [];
    let receive: (event: unknown) => void = () => undefined;
    vm.runInNewContext(getListViewerScript(7, initial), {
        acquireVsCodeApi: () => ({ postMessage: (message: Request) => {
            messages.push(JSON.parse(JSON.stringify(message)) as Request);
        } }),
        document: {
            body: { classList: { toggle: (name: string, enabled: boolean) => {
                if (enabled) {
                    bodyClasses.add(name);
                } else {
                    bodyClasses.delete(name);
                }
            } } },
            createElement: (tag: string) => new Element(tag),
            getElementById: (id: string) => elements[id] ?? new Element('template'),
        },
        window: { addEventListener: (_type: string, listener: typeof receive) => { receive = listener; } },
    });
    const reply = (request: Request, result: Record<string, unknown>) => receive({
        data: { ...request, children: [], next_start: null, ...result },
    });
    return {
        get root() { return root.children[0]; },
        viewport: root, back, breadcrumbs, status, messages, reply, bodyClasses,
    };
}

suite('List viewer', () => {
    test('Back restores expanded rows, loaded pages and scroll without fetching them again', () => {
        const viewer = createViewer();
        const { messages, reply, back, viewport } = viewer;
        assert.strictEqual(back.disabled, true);
        reply(messages[0], { children: [{ label: '$ a', index: 1, viewable: true, has_children: true }] });
        const original = viewer.root;
        const entry = original.children[0].children[0];
        entry.open = true;
        entry.fire('toggle');
        reply(messages[1], { children: [{ label: '$ b', index: 1, viewable: true, has_children: true }] });
        viewport.scrollTop = 120;
        const openButton = entry.children[0].children.at(-1);
        assert.ok(openButton);
        openButton.fire('click', { preventDefault: () => undefined, stopPropagation: () => undefined });
        reply(messages[2], {
            message: 'listview/navigation', navigation: {
                title: 'x$a', path: [1], breadcrumbs: [{ label: 'x', path: [] }, { label: 'a', path: [1] }],
            },
        });
        assert.strictEqual(back.disabled, false);
        assert.deepStrictEqual(messages[3].path, [1]);
        reply(messages[3], { children: [] });
        back.fire('click');
        assert.strictEqual(messages[4].message, 'listview/navigate');
        assert.deepStrictEqual(messages[4].path, []);
        reply(messages[4], {
            message: 'listview/navigation', navigation: { title: 'x', path: [], breadcrumbs: [{ label: 'x', path: [] }] },
        });
        assert.strictEqual(viewer.root, original);
        assert.strictEqual(entry.open, true);
        assert.strictEqual(viewport.scrollTop, 120);
        assert.strictEqual(messages.length, 5);
        assert.strictEqual(back.disabled, true);
    });

    test('breadcrumbs work when opened directly at a deep item and Back follows page history', () => {
        const initial = {
            title: 'x$a$b', path: [1, 2], breadcrumbs: [
                { label: 'x', path: [] }, { label: 'a', path: [1] }, { label: 'b', path: [1, 2] },
            ],
        };
        const viewer = createViewer(initial);
        assert.deepStrictEqual(viewer.messages[0].path, [1, 2]);
        viewer.reply(viewer.messages[0], { children: [] });
        const original = viewer.root;
        assert.deepStrictEqual(viewer.breadcrumbs.children.map(item => item.className),
            ['breadcrumb', 'breadcrumb-separator', 'breadcrumb', 'breadcrumb-separator', 'breadcrumb']);
        viewer.breadcrumbs.children[0].fire('click');
        assert.deepStrictEqual(viewer.messages[1].path, []);
        viewer.reply(viewer.messages[1], {
            message: 'listview/navigation', navigation: { title: 'x', path: [], breadcrumbs: [{ label: 'x', path: [] }] },
        });
        viewer.reply(viewer.messages[2], { children: [] });
        viewer.back.fire('click');
        assert.deepStrictEqual(viewer.messages[3].path, [1, 2]);
        viewer.reply(viewer.messages[3], { message: 'listview/navigation', navigation: initial });
        assert.strictEqual(viewer.root, original);
    });

    test('opening a table and failed navigation leave the list and its history intact', () => {
        const viewer = createViewer();
        viewer.reply(viewer.messages[0], { children: [{ label: '$ df', index: 1, viewable: true }] });
        const original = viewer.root;
        const button = original.children[0].children[0].children[0].children.at(-1);
        assert.ok(button);
        const click = { preventDefault: () => undefined, stopPropagation: () => undefined };
        button.fire('click', click);
        viewer.reply(viewer.messages[1], { message: 'listview/navigation' });
        assert.strictEqual(viewer.root, original);
        assert.strictEqual(viewer.back.disabled, true);
        button.fire('click', click);
        viewer.reply(viewer.messages[2], { message: 'listview/navigation', error: 'Item removed' });
        assert.strictEqual(viewer.status.textContent, 'Item removed');
        assert.strictEqual(viewer.root, original);
        assert.strictEqual(viewer.back.disabled, true);
    });

    test('expands lazily, caches collapsed children, and opens descendants separately', () => {
        const { root, messages, reply } = createViewer();
        assert.deepStrictEqual(messages[0].path, []);
        reply(messages[0], { children: [{ label: '$ a', str: 'List of 1', index: 1, viewable: true, has_children: true }] });
        const entry = root.children[0].children[0];
        assert.strictEqual(entry.tag, 'details');
        assert.strictEqual(entry.children[1].childElementCount, 0);
        assert.strictEqual(messages.length, 1);
        entry.open = true;
        entry.fire('toggle');
        assert.strictEqual(entry.children[1].childElementCount, 3);
        assert.deepStrictEqual(messages[1].path, [1]);
        reply(messages[1], { children: [{ label: '$ b', str: 'List of 1', index: 2, viewable: true, has_children: true }] });
        entry.open = false;
        entry.fire('toggle');
        entry.open = true;
        entry.fire('toggle');
        assert.strictEqual(messages.length, 2);

        const nested = entry.children[1].children[0].children[0];
        nested.open = true;
        nested.fire('toggle');
        assert.deepStrictEqual(messages[2].path, [1, 2]);
        let prevented = false;
        let stopped = false;
        const openButton = nested.children[0].children.at(-1);
        assert.ok(openButton);
        openButton.fire('click', {
            preventDefault: () => { prevented = true; },
            stopPropagation: () => { stopped = true; },
        });
        assert.ok(prevented && stopped);
        assert.strictEqual(messages[3].message, 'listview/view');
        assert.deepStrictEqual(messages[3].path, [1]);
        assert.strictEqual(messages[3].index, 2);
    });

    test('routes concurrent expansion pages, retries failures, and paginates each branch', () => {
        const { root, messages, reply } = createViewer();
        reply(messages[0], { children: [1, 2].map(index => ({ index, label: String(index), has_children: true })) });
        const [first, second] = root.children[0].children;
        first.open = second.open = true;
        first.fire('toggle');
        second.fire('toggle');
        reply(messages[2], { children: [{ label: 'second', index: 1 }], next_start: 501 });
        reply(messages[1], { error: 'Temporarily unavailable' });
        const firstPage = first.children[1];
        const secondPage = second.children[1];
        assert.strictEqual(firstPage.children[2].textContent, 'Temporarily unavailable');
        assert.strictEqual(secondPage.children[0].childElementCount, 1);
        firstPage.children[1].fire('click');
        assert.deepStrictEqual(messages[3].path, [1]);
        reply(messages[3], { children: [] });
        assert.strictEqual(firstPage.children[2].textContent, 'No items');
        secondPage.children[1].fire('click');
        assert.deepStrictEqual(messages[4].path, [2]);
        assert.strictEqual(messages[4].start, 501);
        reply(messages[4], { children: [{ label: 'last', index: 501 }] });
        assert.strictEqual(secondPage.children[0].childElementCount, 2);
        assert.strictEqual(secondPage.children[1].hidden, true);
    });

    test('renders named and unnamed vector rows as plain text', () => {
        const viewer = createViewer({
            title: 'x', path: [], breadcrumbs: [{ label: 'x', path: [] }], vector: true,
        });
        const labels = ['first', '[2]', 'first', '<tag>', 'a b'];
        viewer.reply(viewer.messages[0], {
            children: labels.map((label, index) => ({
                label, str: '12.4', index: index + 1,
                viewable: false, has_children: false,
            })),
        });
        labels.forEach((label, index) => {
            const row = viewer.root.children[0].children[index].children[0];
            assert.deepStrictEqual(row.children.map(child => child.className), ['label', 'str']);
            assert.strictEqual(row.children[0].textContent, label);
            assert.strictEqual(row.children[0].innerHTML, '');
            assert.strictEqual(row.children[1].textContent, '12.4');
            assert.ok(!row.children.some(child => child.tag === 'button'));
        });
    });

    test('vectors share list navigation, Back and cached pages, including late page responses', () => {
        const rootNavigation = { title: 'x', path: [], breadcrumbs: [{ label: 'x', path: [] }] };
        const vectorNavigation = {
            title: 'x$v', path: [1], vector: true,
            breadcrumbs: [{ label: 'x', path: [] }, { label: 'v', path: [1] }],
        };
        const viewer = createViewer(rootNavigation);
        const { messages, reply, back, bodyClasses } = viewer;
        reply(messages[0], { children: [{ label: '$ v', index: 1, viewable: true }] });
        const original = viewer.root;
        viewer.viewport.scrollTop = 120;
        const button = original.children[0].children[0].children[0].children.at(-1);
        assert.ok(button);
        const click = { preventDefault: () => undefined, stopPropagation: () => undefined };
        button.fire('click', click);
        reply(messages[1], { message: 'listview/navigation', navigation: vectorNavigation });
        const vectorPage = viewer.root;
        assert.deepStrictEqual(messages[2].path, [1]);
        assert.ok(bodyClasses.has('vector'));
        assert.strictEqual(back.disabled, false);

        back.fire('click');
        reply(messages[3], { message: 'listview/navigation', navigation: rootNavigation });
        assert.strictEqual(viewer.root, original);
        assert.strictEqual(viewer.viewport.scrollTop, 120);
        assert.ok(!bodyClasses.has('vector'));
        reply(messages[2], {
            children: [{ label: '[1]', str: '42', index: 1, viewable: false, has_children: false }],
        });

        button.fire('click', click);
        reply(messages[4], { message: 'listview/navigation', navigation: vectorNavigation });
        assert.strictEqual(viewer.root, vectorPage);
        assert.strictEqual(messages.length, 5);
        const row = vectorPage.children[0].children[0].children[0];
        assert.deepStrictEqual(row.children.map(child => child.className), ['label', 'str']);
        assert.ok(bodyClasses.has('vector'));
        viewer.breadcrumbs.children[0].fire('click');
        reply(messages[5], { message: 'listview/navigation', navigation: rootNavigation });
        assert.strictEqual(viewer.root, original);
        assert.ok(!bodyClasses.has('vector'));
        back.fire('click');
        reply(messages[6], { message: 'listview/navigation', navigation: vectorNavigation });
        assert.strictEqual(viewer.root, vectorPage);
        assert.ok(bodyClasses.has('vector'));
    });

    test('ignores old viewer responses and hides open buttons for unavailable items', () => {
        const { root, messages, reply } = createViewer();
        reply(messages[0], { documentGeneration: 6, children: [{ label: 'stale' }] });
        assert.strictEqual(root.children[0].childElementCount, 0);
        reply(messages[0], { children: [
            { label: 'removed', viewable: false },
            { label: 'scalar', index: 2, viewable: true, has_children: false },
        ] });
        const [removed, scalar] = root.children[0].children;
        assert.ok(!removed.children[0].children.some(child => child.tag === 'button'));
        assert.ok(scalar.children[0].children.some(child => child.tag === 'button'));
        assert.strictEqual(scalar.tag, 'div');
    });
});
