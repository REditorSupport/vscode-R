import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import type { RExtension } from '../../api';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as session from '../../session';
import { initializeHtmlWidgetViewers, restoreHtmlViewer, runHtmlViewerCommand, showWebView, shutdownHtmlWidgetViewers } from '../../webViewer';
import { extensionContext } from '../../extension';
import { mockExtensionContext } from '../common/mockvscode';
import { waitForValue } from '../common/sessionConnections';

async function focusHtmlViewer(panel: vscode.WebviewPanel): Promise<void> {
    panel.reveal(panel.viewColumn, false);
    // reveal() queues a workbench request. Await editor focus before running
    // commands, rather than relying on a possibly stale panel.active value.
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await waitForValue(() => panel.active &&
        vscode.window.tabGroups.activeTabGroup.activeTab?.label === panel.title ? true : undefined);
}

suite('HTML widget browser rendering', () => {
    test('document edits preserve authored titles, SVG accessibility, and tag-shaped script text', async () => {
        const sandbox = sinon.createSandbox();
        sandbox.stub(vscode.window, 'registerWebviewPanelSerializer').returns({ dispose: sandbox.stub() });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-widget-document-'));
        const panels: vscode.WebviewPanel[] = [];
        let result: vscode.Uri | undefined;
        try {
            mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
            initializeHtmlWidgetViewers(extensionContext, {
                resolveSession: source => session.getViewerSessionContext(source.sessionId, source)!,
                getActiveSessionId: () => session.activeSession?.sessionId,
            });
            const createPanel = vscode.window.createWebviewPanel.bind(vscode.window);
            sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((...args) => {
                const panel = createPanel(...args); panels.push(panel); return panel;
            });
            sandbox.stub(vscode.env, 'openExternal').callsFake(uri => { result = uri; return Promise.resolve(true); });
            for (const structure of ['explicit', 'implicit-head', 'fragment']) {
                result = undefined;
                const title = '<title>Authored R output</title>';
                const content = `<svg><title>Accessible chart</title></svg>
                    <textarea id="example">&lt;head&gt;&lt;/body&gt;</textarea>
                    <script>
                        const example = '</body>';
                        const markup = '<svg><title>Template title</title></svg>';
                        const head = '<head data-example=">">';
                        window.example = example;
                        setTimeout(() => {
                            const observations = new URLSearchParams({
                                title: document.title,
                                svgTitle: document.querySelector('svg title').textContent,
                                example: window.example, markup, head,
                                textarea: document.getElementById('example').value
                            });
                            const report = document.createElement('a');
                            report.href = 'https://widget-test.invalid/document?' + observations;
                            document.body.append(report); report.click();
                        }, 750);
                    </script>`;
                const html = structure === 'explicit'
                    ? `<!doctype html><!-- <head></body> --><html><HEAD data-example=">">${title}</HEAD><BODY>${content}</BODY></html>`
                    : structure === 'implicit-head'
                        ? `<!doctype html><html>${title}<body>${content}</body></html>`
                        : title + content;
                const file = path.join(directory, `${structure}.html`);
                fs.writeFileSync(file, html);
                await showWebView(file, 'History entry title', 'Two');
                const response = await waitForValue(() => result);
                assert.strictEqual(response.path, '/document');
                const observations = new URLSearchParams(response.query);
                assert.strictEqual(observations.get('title'), 'Authored R output', structure);
                assert.strictEqual(observations.get('svgTitle'), 'Accessible chart', structure);
                assert.strictEqual(observations.get('example'), '</body>', structure);
                assert.strictEqual(observations.get('markup'), '<svg><title>Template title</title></svg>', structure);
                assert.strictEqual(observations.get('head'), '<head data-example=">">', structure);
                assert.strictEqual(observations.get('textarea'), '<head></body>', structure);
                assert.strictEqual(panels[panels.length - 1].title, 'HTML Viewer');
                panels[panels.length - 1].dispose();
            }
        } finally {
            panels.forEach(panel => { panel.dispose(); });
            await shutdownHtmlWidgetViewers();
            sandbox.restore();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('authored local bases load relative resources from their own directories', async () => {
        const sandbox = sinon.createSandbox();
        sandbox.stub(vscode.window, 'registerWebviewPanelSerializer').returns({ dispose: sandbox.stub() });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-widget-base-'));
        sandbox.stub(vscode.workspace, 'isTrusted').get(() => true);
        sandbox.stub(vscode.workspace, 'workspaceFolders').get(() => [{
            uri: vscode.Uri.file(directory), name: 'Trusted HTML output workspace', index: 0,
        }]);
        const panels: vscode.WebviewPanel[] = [];
        let result: vscode.Uri | undefined;
        try {
            mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
            initializeHtmlWidgetViewers(extensionContext, {
                resolveSession: source => session.getViewerSessionContext(source.sessionId, source)!,
                getActiveSessionId: () => session.activeSession?.sessionId,
            });
            const createPanel = vscode.window.createWebviewPanel.bind(vscode.window);
            sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((...args) => {
                const panel = createPanel(...args); panels.push(panel); return panel;
            });
            sandbox.stub(vscode.env, 'openExternal').callsFake(uri => { result = uri; return Promise.resolve(true); });
            const output = path.join(directory, 'output');
            const shared = path.join(directory, 'shared assets');
            for (const resources of [path.join(output, 'assets'), shared]) {
                fs.mkdirSync(resources, { recursive: true });
                fs.writeFileSync(path.join(resources, 'data.json'), JSON.stringify({ value: 'authored base' }));
                fs.writeFileSync(path.join(resources, 'widget.css'), '#widget { min-width:137px; }');
                fs.writeFileSync(path.join(resources, 'widget.js'), 'window.authoredBaseScriptLoaded = true;');
            }
            const cases = [
                { href: 'assets/', resources: path.join(output, 'assets') },
                { href: '../shared%20assets/', resources: shared },
                { href: vscode.Uri.file(shared).toString() + '/', resources: shared },
            ];
            for (const [index, fixture] of cases.entries()) {
                result = undefined;
                const file = path.join(output, `index-${index}.html`);
                fs.writeFileSync(file, `<!doctype html><html><head>
                    <base target="_self"><template><base href="ignored-template/"></template>
                    <base href="${fixture.href}" data-authored="yes"><base href="ignored-second/">
                    <link rel="stylesheet" href="widget.css"><script src="widget.js"></script>
                    </head><body><div id="widget">Widget</div><script>
                        setTimeout(async () => {
                            let value;
                            try { value = (await (await fetch('data.json')).json()).value; }
                            catch (error) { value = String(error); }
                            const observations = new URLSearchParams({ value, base: encodeURIComponent(document.baseURI),
                                css: String(getComputedStyle(document.getElementById('widget')).minWidth === '137px'),
                                script: String(window.authoredBaseScriptLoaded === true),
                                authored: document.querySelector('base[data-authored]').getAttribute('data-authored') });
                            const report = document.createElement('a');
                            report.href = 'https://widget-test.invalid/base?' + observations;
                            document.body.append(report); report.click();
                        }, 750);
                    </script></body></html>`);
                await showWebView(file, 'Authored base', 'Two');
                const response = await waitForValue(() => result);
                assert.strictEqual(response.path, '/base');
                const observations = new URLSearchParams(response.query);
                assert.strictEqual(observations.get('value'), 'authored base', fixture.href);
                assert.strictEqual(observations.get('css'), 'true', fixture.href);
                assert.strictEqual(observations.get('script'), 'true', fixture.href);
                assert.strictEqual(observations.get('authored'), 'yes', fixture.href);
                const panel = panels[panels.length - 1];
                // File URLs normalize Windows drive casing during resolution.
                const normalizeBase = (url: string) => new URL(url).href.replace(/\/([a-z])%3A\//i, (_match, drive: string) => `/${drive.toLowerCase()}%3A/`);
                assert.strictEqual(normalizeBase(observations.get('base')!), normalizeBase(String(panel.webview.asWebviewUri(vscode.Uri.file(fixture.resources))) + '/'));
                assert.ok(panel.webview.html.includes('<base href="ignored-second/">'));
                panel.dispose();
            }
        } finally {
            panels.forEach(panel => { panel.dispose(); });
            await shutdownHtmlWidgetViewers();
            sandbox.restore();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('authored bases cannot read files outside the output and trusted workspace', async () => {
        const sandbox = sinon.createSandbox();
        sandbox.stub(vscode.window, 'registerWebviewPanelSerializer').returns({ dispose: sandbox.stub() });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-widget-resource-scope-'));
        const trusted = path.join(directory, 'workspace');
        const output = path.join(trusted, 'output');
        const previous = path.join(trusted, 'previous-output');
        const outside = path.join(directory, 'outside');
        const panels: vscode.WebviewPanel[] = [];
        const source = session.registerSessionTransport('html-browser-resource-scope', 'widget-test-host', directory, () => Promise.resolve({}));
        source.pid = '12106'; source.rVer = '4.6.1';
        let result: vscode.Uri | undefined;
        try {
            fs.mkdirSync(output, { recursive: true });
            fs.mkdirSync(previous);
            const previousFile = path.join(previous, 'index.html');
            fs.writeFileSync(previousFile, '<html><body>Previously registered output</body></html>');
            fs.mkdirSync(outside);
            const privateFile = path.join(outside, 'private.json');
            fs.writeFileSync(privateFile, JSON.stringify({ value: 'outside permitted resources' }));
            sandbox.stub(vscode.workspace, 'isTrusted').get(() => true);
            sandbox.stub(vscode.workspace, 'workspaceFolders').get(() => [{
                uri: vscode.Uri.file(trusted), name: 'Trusted HTML output workspace', index: 0,
            }]);
            mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
            initializeHtmlWidgetViewers(extensionContext, {
                resolveSession: source => session.getViewerSessionContext(source.sessionId, source)!,
                getActiveSessionId: () => session.activeSession?.sessionId,
            });
            const createPanel = vscode.window.createWebviewPanel.bind(vscode.window);
            sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((...args) => {
                const panel = createPanel(...args); panels.push(panel); return panel;
            });
            sandbox.stub(vscode.env, 'openExternal').callsFake(uri => { result = uri; return Promise.resolve(true); });
            const rootRelative = path.relative(path.parse(privateFile).root, privateFile).split(path.sep).map(encodeURIComponent).join('/');
            for (const fixture of [
                { href: '/', resource: rootRelative },
                { href: '../../outside/', resource: 'private.json' },
                { href: vscode.Uri.file(outside).toString() + '/', resource: 'private.json' },
            ]) {
                result = undefined;
                await showWebView(previousFile, 'Previous output', 'Two', session.getViewerSessionContext(source.sessionId));
                const file = path.join(output, 'index.html');
                fs.writeFileSync(file, `<!doctype html><html><head><base href="${fixture.href}"></head><body><script>
                    setTimeout(async () => {
                        let access = 'blocked';
                        try { if ((await fetch(${JSON.stringify(fixture.resource)})).ok) access = 'allowed'; } catch {}
                        const report = document.createElement('a');
                        report.href = 'https://widget-test.invalid/resource-scope?access=' + access;
                        document.body.append(report); report.click();
                    }, 750);
                    </script></body></html>`);
                await showWebView(file, 'Resource scope', 'Two', session.getViewerSessionContext(source.sessionId));
                const response = await waitForValue(() => result);
                assert.strictEqual(new URLSearchParams(response.query).get('access'), 'blocked', fixture.href);
                assert.strictEqual(panels[panels.length - 1].webview.options.localResourceRoots?.length, 3,
                    'Retain only the two registered output directories and viewer assets');
                panels[panels.length - 1].dispose();
            }
        } finally {
            panels.forEach(panel => { panel.dispose(); });
            await shutdownHtmlWidgetViewers();
            session.unregisterSessionTransport(source);
            sandbox.restore();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('Cmd/Ctrl+F inside the widget opens native Find while other keys stay with the widget', async () => {
        const sandbox = sinon.createSandbox();
        sandbox.stub(vscode.window, 'registerWebviewPanelSerializer').returns({ dispose: sandbox.stub() });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-widget-find-'));
        const panels: vscode.WebviewPanel[] = [];
        let result: vscode.Uri | undefined;
        let findCommands = 0;
        const source = session.registerSessionTransport('html-browser-find', 'widget-test-host', directory, () => Promise.resolve({}));
        source.pid = '12103'; source.rVer = '4.6.1';
        try {
            mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
            initializeHtmlWidgetViewers(extensionContext, {
                resolveSession: source => session.getViewerSessionContext(source.sessionId, source)!,
                getActiveSessionId: () => session.activeSession?.sessionId,
            });
            const createPanel = vscode.window.createWebviewPanel.bind(vscode.window);
            sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((...args) => {
                const panel = createPanel(...args); panels.push(panel); return panel;
            });
            const executeCommand = vscode.commands.executeCommand.bind(vscode.commands);
            const command = sandbox.stub(vscode.commands, 'executeCommand').callThrough();
            command.withArgs('editor.action.webvieweditor.showFind').callsFake(async () => {
                await executeCommand('editor.action.webvieweditor.showFind');
                findCommands++;
            });
            sandbox.stub(vscode.env, 'openExternal').callsFake(uri => { result = uri; return Promise.resolve(true); });
            const file = path.join(directory, 'index.html');
            fs.writeFileSync(file, `<!doctype html><html><body>
                <p>Searchable widget content</p><input id="widget-input">
                <script>
                    setTimeout(() => {
                        const input = document.getElementById('widget-input');
                        input.focus();
                        const results = new URLSearchParams();
                        const key = (name, options) => {
                            const event = new KeyboardEvent('keydown', {key:'f', code:'KeyF', bubbles:true, cancelable:true, ...options});
                            input.dispatchEvent(event);
                            results.set(name, String(event.defaultPrevented));
                        };
                        key('plain', {});
                        key('shift', {ctrlKey:true, shiftKey:true});
                        key('alt', {ctrlKey:true, altKey:true});
                        input.addEventListener('keydown', event => event.preventDefault(), {once:true});
                        key('handled', {ctrlKey:true});
                        key('ctrl', {ctrlKey:true});
                        key('cmd', {key:'F', metaKey:true});
                        const report = document.createElement('a'); report.href = 'https://widget-test.invalid/find?' + results; document.body.append(report); report.click();
                    }, 750);
                </script>
            </body></html>`);
            await showWebView(file, 'Find in widget', 'Two', session.getViewerSessionContext(source.sessionId));
            const response = await waitForValue(() => result);
            assert.strictEqual(response.path, '/find');
            const observations = new URLSearchParams(response.query);
            for (const name of ['ctrl', 'cmd', 'handled']) { assert.strictEqual(observations.get(name), 'true', name); }
            for (const name of ['plain', 'shift', 'alt']) { assert.strictEqual(observations.get(name), 'false', name); }
            await waitForValue(() => findCommands === 2 ? true : undefined);
            assert.strictEqual(command.withArgs('editor.action.webvieweditor.showFind').callCount, 2);
            assert.strictEqual(panels.length, 1);
            assert.strictEqual(vscode.window.tabGroups.activeTabGroup.activeTab?.label, 'HTML Viewer');
            assert.ok(!panels[0].webview.html.includes('widget-frame'));
        } finally {
            panels.forEach(panel => { panel.dispose(); });
            await shutdownHtmlWidgetViewers();
            session.unregisterSessionTransport(source);
            sandbox.restore();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('fragment links scroll to IDs and named anchors inside the widget without leaving its document', async () => {
        const sandbox = sinon.createSandbox();
        sandbox.stub(vscode.window, 'registerWebviewPanelSerializer').returns({ dispose: sandbox.stub() });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-widget-fragments-'));
        const panels: vscode.WebviewPanel[] = [];
        let result: vscode.Uri | undefined;
        const source = session.registerSessionTransport('html-browser-fragments', 'widget-test-host', directory, () => Promise.resolve({}));
        source.pid = '12102'; source.rVer = '4.6.1';
        try {
            mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
            initializeHtmlWidgetViewers(extensionContext, {
                resolveSession: source => session.getViewerSessionContext(source.sessionId, source)!,
                getActiveSessionId: () => session.activeSession?.sessionId,
            });
            const createPanel = vscode.window.createWebviewPanel.bind(vscode.window);
            sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((...args) => {
                const panel = createPanel(...args); panels.push(panel); return panel;
            });
            sandbox.stub(vscode.env, 'openExternal').callsFake(uri => { result = uri; return Promise.resolve(true); });
            const file = path.join(directory, 'index.html');
            fs.writeFileSync(file, `<!doctype html><html><head><style>
                html { scroll-behavior:auto; } body { margin:0; } .gap { height:1500px; }
            </style></head><body>
                <a id="toc" href="#section"><span>Section</span></a>
                <a id="encoded" href="#section%20two">Encoded ID</a>
                <a id="named" href="#legacy">Named anchor</a>
                <a id="empty" href="#">Top</a><a id="topLink" href="#top">Top</a>
                <a id="missingLink" href="#missing">Missing target</a>
                <a id="malformed" href="#bad%ZZ">Malformed fragment</a>
                <div class="gap"></div><h2 id="section">Section</h2>
                <div class="gap"></div><h2 id="section two">Encoded section</h2>
                <div class="gap"></div><a name="legacy">Legacy section</a><div class="gap"></div>
                <script>
                    setTimeout(() => {
                        const results = new URLSearchParams();
                        const click = (id, target) => {
                            let intercepted = false;
                            document.addEventListener('click', event => {
                                intercepted = event.defaultPrevented;
                                // A broken bridge must still return its observations.
                                event.preventDefault();
                            }, {once:true});
                            (document.querySelector('#' + id + ' span') || document.getElementById(id)).click();
                            results.set(id, String(intercepted && (!target || Math.abs(target.getBoundingClientRect().top) < 2)));
                        };
                        click('toc', document.getElementById('section'));
                        click('encoded', document.getElementById('section two'));
                        click('named', document.getElementsByName('legacy')[0]);
                        click('empty'); results.set('emptyTop', String(scrollY === 0));
                        window.scrollTo(0, 500);
                        click('topLink'); results.set('topTop', String(scrollY === 0));
                        window.scrollTo(0, 500);
                        const retainedScroll = scrollY;
                        click('missingLink'); results.set('missingStayed', String(scrollY === retainedScroll));
                        click('malformed'); results.set('malformedStayed', String(scrollY === retainedScroll));
                        const report = document.createElement('a'); report.href = 'https://widget-test.invalid/fragments?' + results; document.body.append(report); report.click();
                    }, 750);
                </script>
            </body></html>`);
            await showWebView(file, 'Report fragments', 'Two', session.getViewerSessionContext(source.sessionId));
            const response = await waitForValue(() => result);
            assert.strictEqual(response.path, '/fragments');
            const observations = new URLSearchParams(response.query);
            for (const key of ['toc', 'encoded', 'named', 'empty', 'emptyTop', 'topLink', 'topTop', 'missingLink', 'missingStayed', 'malformed', 'malformedStayed']) {
                assert.strictEqual(observations.get(key), 'true', `${key} must stay within the displayed HTML document`);
            }
            assert.strictEqual(panels.length, 1);
        } finally {
            panels.forEach(panel => { panel.dispose(); });
            await shutdownHtmlWidgetViewers();
            session.unregisterSessionTransport(source);
            sandbox.restore();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('history navigation keeps the previous HTML visible without rerunning it', async () => {
        const sandbox = sinon.createSandbox();
        sandbox.stub(vscode.window, 'registerWebviewPanelSerializer').returns({ dispose: sandbox.stub() });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-widget-switch-'));
        const panels: vscode.WebviewPanel[] = [];
        const reports: vscode.Uri[] = [];
        const writes: Array<Promise<void>> = [];
        let clears = 0;
        const contexts = new Map<string, unknown>();
        const source = session.registerSessionTransport('html-browser-switch', 'widget-test-host', directory, () => Promise.resolve({}));
        source.pid = '12105'; source.rVer = '4.6.1';
        try {
            mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
            const viewerManager = initializeHtmlWidgetViewers(extensionContext, {
                resolveSession: source => session.getViewerSessionContext(source.sessionId, source)!,
                getActiveSessionId: () => session.activeSession?.sessionId,
            });
            const executeCommand = vscode.commands.executeCommand.bind(vscode.commands);
            sandbox.stub(vscode.commands, 'executeCommand').callThrough().withArgs('setContext')
                .callsFake((_command: string, key: string, value: unknown) => {
                    contexts.set(key, value); return executeCommand('setContext', key, value);
                });
            const createPanel = vscode.window.createWebviewPanel.bind(vscode.window);
            sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((...args) => {
                const panel = createPanel(...args);
                panels.push(panel);
                // Delay replacement delivery to exercise the interval between the
                // options and HTML workbench messages, without delaying a clear.
                const webview = panel.webview;
                const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(webview), 'html')!;
                sandbox.stub(webview, 'html').get(() => descriptor.get!.call(webview) as string).set((html: string) => {
                    if (!html) { clears++; descriptor.set!.call(webview, html); return; }
                    writes.push(new Promise(resolve => setTimeout(() => {
                        descriptor.set!.call(webview, html); resolve();
                    }, 500)));
                });
                return panel;
            });
            sandbox.stub(vscode.env, 'openExternal').callsFake(uri => { reports.push(uri); return Promise.resolve(true); });
            const fixture = (name: string) => {
                const root = path.join(directory, name);
                fs.mkdirSync(root);
                fs.writeFileSync(path.join(root, 'style.css'), 'table { width:200px; margin-left:auto; margin-right:auto; }');
                const file = path.join(root, 'index.html');
                fs.writeFileSync(file, `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>
                    ${name === 'table' ? '<table><tr><td>Centered flextable output</td></tr></table>' : '<p>HTML file output</p>'}
                    <script>window.addEventListener('load', () => setTimeout(() => {
                        const table = document.querySelector('table');
                        const centered = !table || Math.abs(table.getBoundingClientRect().left + table.offsetWidth / 2 - innerWidth / 2) < 2;
                        const report = document.createElement('a');
                        report.href = 'https://widget-test.invalid/${name}?centered=' + centered;
                        document.body.append(report); report.click();
                    }, 50));</script></body></html>`);
                return file;
            };
            const table = fixture('table');
            const html = fixture('html');
            const loaded = async (count: number) => {
                await Promise.all(writes);
                await waitForValue(() => reports.length >= count &&
                    [...viewerManager.viewers.values()].some(entry => entry.panel === panels[0] && !entry.loading) ? true : undefined);
            };
            const disabled = () => ['canGoBack', 'canGoForward', 'canRemove']
                .every(key => contexts.get(`r.htmlViewer.${key}`) === false);
            await showWebView(table, 'Table', 'Two', session.getViewerSessionContext(source.sessionId));
            await loaded(1);
            await showWebView(html, 'HTML', 'Two', session.getViewerSessionContext(source.sessionId));
            await loaded(2);
            const previousClears = clears;
            const roots = panels[0].webview.options.localResourceRoots!.map(root => root.toString());
            await focusHtmlViewer(panels[0]);
            await runHtmlViewerCommand('back');
            assert.ok(disabled(), 'Buttons must stay disabled while replacement delivery is pending');
            assert.ok(panels[0].webview.html.includes('HTML file output'), 'Keep the current output until replacement arrives');
            assert.strictEqual(clears, previousClears, 'Back must not insert a blank document');
            assert.deepStrictEqual(panels[0].webview.options.localResourceRoots!.map(root => root.toString()), roots);
            const pendingBackWrites = writes.length;
            await runHtmlViewerCommand('forward');
            assert.strictEqual(writes.length, pendingBackWrites, 'Ignore repeated clicks during the transition');
            await loaded(3);
            assert.strictEqual(contexts.get('r.htmlViewer.canGoBack'), false);
            assert.strictEqual(contexts.get('r.htmlViewer.canGoForward'), true);
            await focusHtmlViewer(panels[0]);
            await runHtmlViewerCommand('forward');
            assert.ok(disabled(), 'Forward must wait for the selected document to load');
            assert.ok(panels[0].webview.html.includes('Centered flextable output'), 'Keep the current table until replacement arrives');
            assert.strictEqual(clears, previousClears, 'Forward must not insert a blank document');
            assert.deepStrictEqual(panels[0].webview.options.localResourceRoots!.map(root => root.toString()), roots);
            await loaded(4);
            assert.strictEqual(contexts.get('r.htmlViewer.canGoBack'), true);
            assert.strictEqual(contexts.get('r.htmlViewer.canGoForward'), false);
            assert.deepStrictEqual(reports.map(uri => uri.path), ['/table', '/html', '/table', '/html']);
            assert.ok(reports.every(uri => new URLSearchParams(uri.query).get('centered') === 'true'),
                'The table must retain its authored centering on every load');
        } finally {
            await Promise.all(writes);
            panels.forEach(panel => { panel.dispose(); });
            await shutdownHtmlWidgetViewers();
            session.unregisterSessionTransport(source);
            sandbox.restore();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('native actions navigate, remove, and restore full documents with relative resources', async () => {
        const sandbox = sinon.createSandbox();
        sandbox.stub(vscode.window, 'registerWebviewPanelSerializer').returns({ dispose: sandbox.stub() });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-widget-browser-'));
        const panels: vscode.WebviewPanel[] = [];
        const urls: vscode.Uri[] = [];
        const source = session.registerSessionTransport('html-browser-rendering', 'widget-test-host', directory, () => Promise.resolve({}));
        source.pid = '12101'; source.rVer = '4.6.1';
        try {
            mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
            const viewerManager = initializeHtmlWidgetViewers(extensionContext, {
                resolveSession: source => session.getViewerSessionContext(source.sessionId, source)!,
                getActiveSessionId: () => session.activeSession?.sessionId,
            });
            const createPanel = vscode.window.createWebviewPanel.bind(vscode.window);
            sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((...args) => {
                const panel = createPanel(...args); panels.push(panel); return panel;
            });
            sandbox.stub(vscode.env, 'openExternal').callsFake(uri => { urls.push(uri); return Promise.resolve(true); });
            const fixture = (name: string) => {
                const root = path.join(directory, name);
                fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
                fs.writeFileSync(path.join(root, 'lib/widget.css'), '#widget { min-width:137px; }' +
                    (name === 'first' ? 'body { background:white; }' : 'body { background:#123; color:#eee; } code { color:#abc; background:#234; }'));
                fs.writeFileSync(path.join(root, 'lib/pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');
                fs.writeFileSync(path.join(root, 'lib/data.json'), JSON.stringify({ name }));
                fs.writeFileSync(path.join(root, 'lib/widget.js'), `let reports = 0; let fetched = false;
                    fetch('lib/data.json').then(response => response.json()).then(data => { fetched = data.name === '${name}'; });
                    const report = document.createElement('a'); document.body.append(report);
                    const timer = setInterval(() => {
                        const params = new URLSearchParams({ width: String(innerWidth), height: String(innerHeight),
                            css: String(getComputedStyle(document.getElementById('widget')).minWidth === '137px'),
                            image: String(document.getElementById('widget-image').naturalWidth === 1), fetch: String(fetched),
                            direct: String(!document.getElementById('widget-frame') && !document.getElementById('widget-toolbar')),
                            textColor: getComputedStyle(document.getElementById('markdown-text')).color,
                            codeColor: getComputedStyle(document.getElementById('markdown-code')).color });
                        report.href = 'https://widget-test.invalid/${name}?' + params; report.click();
                        if (++reports === 30) clearInterval(timer);
                    }, 100);`);
                const file = path.join(root, 'index.html');
                fs.writeFileSync(file, `<!doctype html><html><head><style>body { margin:0; font-size:80px; } #widget { height:100vh; }</style><link rel="stylesheet" href="lib/widget.css"></head><body><div id="widget">${name}<p id="markdown-text">Rendered Markdown <code id="markdown-code">inline code</code></p><img id="widget-image" src="lib/pixel.svg"></div><script src="lib/widget.js"></script></body></html>`);
                return file;
            };
            const first = fixture('first');
            const second = fixture('second');
            const count = (name: string) => urls.filter(uri => uri.path === `/${name}`).length;
            const loaded = async (name: string, previous: number) => {
                const uri = await waitForValue(() => {
                    const reports = urls.filter(uri => uri.path === `/${name}`);
                    const latest = reports.at(-1);
                    const params = new URLSearchParams(latest?.query);
                    return reports.length > previous && ['css', 'image', 'fetch', 'direct'].every(key => params.get(key) === 'true') &&
                        [...viewerManager.viewers.values()].some(entry => entry.panel === panels.at(-1) && !entry.loading) ? latest : undefined;
                });
                const dimensions = new URLSearchParams(uri.query);
                assert.ok(Number(dimensions.get('width')) > 0 && Number(dimensions.get('height')) > 0);
                assert.strictEqual(dimensions.get('textColor'), name === 'first' ? 'rgb(0, 0, 0)' : 'rgb(238, 238, 238)');
                assert.strictEqual(dimensions.get('codeColor'), name === 'first' ? 'rgb(0, 0, 0)' : 'rgb(170, 187, 204)');
                assert.ok(!panels.at(-1)!.webview.html.includes('r-html-viewer-info'));
            };
            await showWebView(first, 'First widget', 'Two', session.getViewerSessionContext(source.sessionId));
            await loaded('first', 0);
            await showWebView(second, 'Second widget', 'Two', session.getViewerSessionContext(source.sessionId));
            await loaded('second', 0);
            assert.strictEqual(panels.length, 1);
            const panel = panels[0];
            assert.strictEqual(panel.viewType, 'r.htmlViewer');
            await focusHtmlViewer(panel);
            const firstCount = count('first');
            await runHtmlViewerCommand('back');
            await loaded('first', firstCount);
            const secondCount = count('second');
            await runHtmlViewerCommand('forward');
            await loaded('second', secondCount);
            const removeCount = count('first');
            await runHtmlViewerCommand('remove');
            await loaded('first', removeCount);
            assert.ok(fs.existsSync(second), 'Removing history must preserve the original HTML file');
            const information = sandbox.stub(vscode.window, 'showInformationMessage').resolves();
            const html = panel.webview.html;
            await focusHtmlViewer(panel);
            await runHtmlViewerCommand('info');
            assert.strictEqual(panel.title, `HTML Viewer · R 4.6.1: ${source.pid}`);
            assert.strictEqual(panel.webview.html, html);
            await focusHtmlViewer(panel);
            await runHtmlViewerCommand('info');
            assert.strictEqual(panel.title, 'HTML Viewer');
            sinon.assert.notCalled(information);
            panel.dispose();
            const restoreCount = count('first');
            await restoreHtmlViewer(source.sessionId);
            await loaded('first', restoreCount);
            assert.strictEqual(panels.length, 2);
            assert.strictEqual(panels[1].title, 'HTML Viewer');
        } finally {
            panels.forEach(panel => { panel.dispose(); });
            await shutdownHtmlWidgetViewers();
            session.unregisterSessionTransport(source);
            sandbox.restore();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    test('registered native commands operate on HTML outputs received by the activated extension', async () => {
        const sandbox = sinon.createSandbox();
        sandbox.stub(vscode.window, 'registerWebviewPanelSerializer').returns({ dispose: sandbox.stub() });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-native-commands-'));
        const panels: vscode.WebviewPanel[] = [];
        const loaded = new Map<vscode.WebviewPanel, number>();
        const contexts = new Map<string, unknown>();
        let client: net.Socket | undefined;
        try {
            const extension = vscode.extensions.getExtension<RExtension>('REditorSupport.r');
            assert.ok(extension);
            const api = await extension.activate();
            const connection = await api.session.getConnectionInfo();
            assert.ok(connection, 'The activated extension must expose its session endpoint');
            const executeCommand = vscode.commands.executeCommand.bind(vscode.commands);
            sandbox.stub(vscode.commands, 'executeCommand').callThrough().withArgs('setContext')
                .callsFake((_command: string, key: string, value: unknown) =>
                    executeCommand('setContext', key, value).then(() => { contexts.set(key, value); }));
            const createPanel = vscode.window.createWebviewPanel.bind(vscode.window);
            sandbox.stub(vscode.window, 'createWebviewPanel').callsFake((...args) => {
                const panel = createPanel(...args);
                if (panel.viewType === 'r.htmlViewer') {
                    panels.push(panel);
                    panel.webview.onDidReceiveMessage((message: { message?: string; generation?: number }) => {
                        if (message.message === 'widget/loaded' && typeof message.generation === 'number') {
                            loaded.set(panel, message.generation);
                        }
                    });
                }
                return panel;
            });
            const information = sandbox.stub(vscode.window, 'showInformationMessage').resolves();
            const id = `native-toolbar-${Date.now()}`;
            client = net.createConnection(connection.endpoint);
            let attached = false;
            let buffer = '';
            const socket = client;
            socket.on('data', data => {
                buffer += data.toString();
                let newline: number;
                while ((newline = buffer.indexOf('\n')) >= 0) {
                    const request = JSON.parse(buffer.slice(0, newline)) as { id?: number; method?: string };
                    buffer = buffer.slice(newline + 1);
                    if (request.id === undefined) { continue; }
                    if (request.method === 'workspace') { attached = true; }
                    socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
                        result: request.method === 'workspace' ? { globalenv: {}, search: [], loaded_namespaces: [] } : true }) + '\n');
                }
            });
            await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
            const notify = (method: string, params: Record<string, unknown>) => {
                socket.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
            };
            notify('attach', { protocol_version: connection.protocolVersion, session_id: id,
                host: 'native-toolbar-test-host', pid: '12104', version: '4.6.1', tempdir: directory, wd: directory });
            await waitForValue(() => attached ? true : undefined);
            const first = path.join(directory, 'first.html');
            const second = path.join(directory, 'second.html');
            fs.writeFileSync(first, '<!doctype html><html><head></head><body>Native first</body></html>');
            fs.writeFileSync(second, '<!doctype html><html><head></head><body>Native second</body></html>');
            notify('webview', { url: first, title: 'First' });
            const panel = await waitForValue(() => panels[0]?.webview.html.includes('Native first') ? panels[0] : undefined);
            const run = async (viewer: vscode.WebviewPanel, action: 'back' | 'forward' | 'remove' | 'info') => {
                const generation = () => Number(/data-generation="(\d+)"/.exec(viewer.webview.html)?.[1]);
                const ready = () => loaded.get(viewer) === generation();
                await waitForValue(() => ready() ? true : undefined);
                await focusHtmlViewer(viewer);
                const key = { back: 'canGoBack', forward: 'canGoForward', remove: 'canRemove', info: 'canShowInfo' }[action];
                // A browser acknowledgement can precede the workbench's toolbar
                // update. Wait for the native command to be enabled as well.
                await waitForValue(() => ready() && viewer.active && contexts.get(`r.htmlViewer.${key}`) === true ? true : undefined);
                const previousGeneration = generation();
                await vscode.commands.executeCommand(`r.htmlViewer.${action}`);
                // Navigation must load a new document, rather than accepting the
                // previous page's acknowledgement if the command was ignored.
                await waitForValue(() => ready() && (action === 'info' || generation() > previousGeneration) ? true : undefined);
                // Title changes reach the workbench asynchronously. Navigation
                // preserves focus, so check the viewer's group even if another
                // group becomes active before the next action refocuses it.
                await waitForValue(() => vscode.window.tabGroups.all.find(group =>
                    group.viewColumn === viewer.viewColumn)?.activeTab?.label === viewer.title ? true : undefined);
            };
            notify('webview', { url: second, title: 'Second' });
            await waitForValue(() => panel.webview.html.includes('Native second') ? true : undefined);
            await run(panel, 'back');
            assert.ok(panel.webview.html.includes('Native first'));
            await run(panel, 'forward');
            assert.ok(panel.webview.html.includes('Native second'));
            const html = panel.webview.html;
            await run(panel, 'info');
            assert.strictEqual(panel.title, 'HTML Viewer · R 4.6.1: 12104');
            assert.strictEqual(panel.webview.html, html);
            await run(panel, 'info');
            assert.strictEqual(panel.title, 'HTML Viewer');
            sinon.assert.notCalled(information);
            await run(panel, 'remove');
            assert.ok(panel.webview.html.includes('Native first'));
            assert.ok(fs.existsSync(second));
            panel.dispose();
            await vscode.commands.executeCommand('r.htmlViewer.restore', id);
            assert.strictEqual(panels.length, 2);
            assert.ok(panels[1].webview.html.includes('Native first'));
            await run(panels[1], 'remove');
            assert.ok(panels[1].webview.html.includes('No HTML outputs in this session'));
        } finally {
            panels.forEach(panel => { panel.dispose(); });
            client?.destroy();
            sandbox.restore();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

});
