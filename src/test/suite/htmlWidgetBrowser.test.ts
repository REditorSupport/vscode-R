import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as session from '../../session';
import { restoreHtmlViewer, showWebView, shutdownHtmlWidgetViewers } from '../../webViewer';
import { mockExtensionContext } from '../common/mockvscode';
import { waitForValue } from '../common/sessionConnections';

suite('HTML widget browser rendering', () => {
    test('loads relative dependencies, navigates, and restores a closed Viewer with the real toolbar', async () => {
        const sandbox = sinon.createSandbox();
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-widget-browser-'));
        const panels: vscode.WebviewPanel[] = [];
        const urls: vscode.Uri[] = [];
        const source = session.registerSessionTransport('html-browser-rendering', 'widget-test-host', directory, () => Promise.resolve({}));
        source.pid = '12101'; source.rVer = '4.6.1';
        try {
            mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
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
            panel.dispose();
            const restoreCount = count('second');
            await restoreHtmlViewer(source.sessionId);
            await loaded('second', restoreCount);
            assert.strictEqual(panels.length, 2);
            assert.strictEqual(panels[1].title, 'HTML Viewer');
            assert.ok(panels[1].webview.html.includes('2 / 2'));
        } finally {
            panels.forEach(panel => { panel.dispose(); });
            await shutdownHtmlWidgetViewers();
            session.unregisterSessionTransport(source);
            sandbox.restore();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
