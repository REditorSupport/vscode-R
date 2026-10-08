import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as session from '../../session';
import { initializeHtmlWidgetViewers, restoreHtmlViewer, showWebView, shutdownHtmlWidgetViewers } from '../../webViewer';
import { extensionContext } from '../../extension';
import { mockExtensionContext } from '../common/mockvscode';
import { waitForValue } from '../common/sessionConnections';

suite('HTML widget browser rendering', () => {
    test('Cmd/Ctrl+F inside the widget opens native Find while other keys stay with the widget', async () => {
        const sandbox = sinon.createSandbox();
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
                        parent.postMessage({message:'widget/bridge', href:'https://widget-test.invalid/find?' + results}, '*');
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
            assert.ok(panels[0].webview.html.includes('1 / 1'));
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
                        parent.postMessage({message:'widget/bridge', href:'https://widget-test.invalid/fragments?' + results}, '*');
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

    test('loads relative dependencies, navigates, removes an output, and restores with the real toolbar', async () => {
        const sandbox = sinon.createSandbox();
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-widget-browser-'));
        const panels: vscode.WebviewPanel[] = [];
        const urls: vscode.Uri[] = [];
        const source = session.registerSessionTransport('html-browser-rendering', 'widget-test-host', directory, () => Promise.resolve({}));
        source.pid = '12101'; source.rVer = '4.6.1';
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
            sandbox.stub(vscode.env, 'openExternal').callsFake(uri => { urls.push(uri); return Promise.resolve(true); });
            const fixture = (name: string) => {
                const root = path.join(directory, name);
                fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
                fs.writeFileSync(path.join(root, 'lib/widget.js'), `let reports = 0; const timer = setInterval(() => {
                    window.parent.postMessage({ message: 'widget/bridge', href: 'https://widget-test.invalid/${name}?width=' + innerWidth + '&height=' + innerHeight }, '*');
                    if (++reports === 20) clearInterval(timer);
                }, 100);`);
                const file = path.join(root, 'index.html');
                fs.writeFileSync(file, `<!doctype html><html><head><style>body { margin:0; font-size:80px; } #widget { height:100vh; }</style><script src="lib/widget.js"></script></head><body><div id="widget">${name}</div></body></html>`);
                return file;
            };
            const first = fixture('first');
            const second = fixture('second');
            const count = (name: string) => urls.filter(uri => uri.path === `/${name}`).length;
            const loaded = async (name: string, previous: number) => {
                await waitForValue(() => count(name) > previous ? true : undefined);
                const uri = urls.filter(uri => uri.path === `/${name}`).at(-1)!;
                const dimensions = new URLSearchParams(uri.query);
                assert.ok(Number(dimensions.get('width')) > 0 && Number(dimensions.get('height')) > 0);
            };
            await showWebView(first, 'First widget', 'Two', session.getViewerSessionContext(source.sessionId));
            await loaded('first', 0);
            await showWebView(second, 'Second widget', 'Two', session.getViewerSessionContext(source.sessionId));
            await loaded('second', 0);
            assert.strictEqual(panels.length, 1);
            const panel = panels[0];
            let controlRevision = 0;
            // A test-only host script drives native button clicks and reports geometry.
            const installControls = async (name: string) => {
                const previous = count(name);
                const token = ++controlRevision;
                panel.webview.html = panel.webview.html.replace('</body></html>', `<script>
                    window.addEventListener('message', event => {
                        if (event.data?.message === 'widget-test/navigate') {
                            document.getElementById('widget-' + event.data.direction).click();
                        } else if (event.data?.message === 'widget-test/remove') {
                            document.getElementById('widget-remove').click();
                        } else if (event.data?.message === 'widget-test/inspect') {
                            const toolbar = document.getElementById('widget-toolbar');
                            const frame = document.getElementById('widget-frame');
                            const good = toolbar.getBoundingClientRect().height > 0 && frame.getBoundingClientRect().height > 0 &&
                                frame.getBoundingClientRect().bottom <= innerHeight + 1 &&
                                getComputedStyle(toolbar).fontSize !== '80px' && toolbar.querySelector('.viewer-session');
                            window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow,
                                data: { message: 'widget/bridge', href: 'https://widget-test.invalid/host?good=' + Boolean(good) } }));
                        }
                    });
                    window.dispatchEvent(new MessageEvent('message', { source: document.getElementById('widget-frame').contentWindow,
                        data: { message: 'widget/bridge', href: 'https://widget-test.invalid/controls?token=${token}' } }));
                </script></body></html>`);
                await waitForValue(() => urls.find(uri => uri.path === '/controls' && uri.query === 'token=' + token));
                await loaded(name, previous);
            };
            await installControls('second');
            await panel.webview.postMessage({ message: 'widget-test/inspect' });
            await waitForValue(() => urls.find(uri => uri.path === '/host'));
            assert.ok(urls.find(uri => uri.path === '/host')?.query.includes('good=true'));
            const firstCount = count('first');
            await panel.webview.postMessage({ message: 'widget-test/navigate', direction: 'back' });
            await loaded('first', firstCount);
            assert.strictEqual(panel.title, 'HTML Viewer');
            await installControls('first');
            const secondCount = count('second');
            await panel.webview.postMessage({ message: 'widget-test/navigate', direction: 'forward' });
            await loaded('second', secondCount);
            assert.strictEqual(panel.title, 'HTML Viewer');
            await installControls('second');
            const removeCount = count('first');
            await panel.webview.postMessage({ message: 'widget-test/remove' });
            await loaded('first', removeCount);
            assert.ok(panel.webview.html.includes('1 / 1'));
            assert.ok(fs.existsSync(second), 'Removing history must preserve the original HTML file');
            panel.dispose();
            const restoreCount = count('first');
            await restoreHtmlViewer(source.sessionId);
            await loaded('first', restoreCount);
            assert.strictEqual(panels.length, 2);
            assert.strictEqual(panels[1].title, 'HTML Viewer');
            assert.ok(panels[1].webview.html.includes('1 / 1'));
        } finally {
            panels.forEach(panel => { panel.dispose(); });
            await shutdownHtmlWidgetViewers();
            session.unregisterSessionTransport(source);
            sandbox.restore();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
