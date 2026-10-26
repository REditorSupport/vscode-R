const assert = require('node:assert/strict');
const fs = require('node:fs');
const { isBuiltin } = require('node:module');
const path = require('node:path');
const { before, describe, test } = require('node:test');
const { runInNewContext } = require('node:vm');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const plotRoot = path.join(root, 'src/plotViewer/webview');
const plot = { id: '1', host: 'localhost:1234', data: '<svg><text>Test plot</text></svg>' };

async function loadViewer(source, minify) {
    // Keep EJS bundled so its import condition matches the published extension.
    // Isolate unrelated extension services without starting VS Code or R.
    const services = {
        vscode: { Uri: { file: (fsPath) => ({ fsPath }) } },
        '../util': { makeWebviewCommandUriString: (command) => `command:${command}` },
        '../extension': {},
        './httpgdClient': {},
        './packages': {},
    };
    const result = await esbuild.build({
        absWorkingDir: root,
        entryPoints: [source],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node22',
        minify,
        external: Object.keys(services),
        write: false,
        logLevel: 'silent',
    });
    const module = { exports: {} };
    runInNewContext(result.outputFiles[0].text, {
        module,
        require: (name) => {
            if (isBuiltin(name)) {
                return require(name);
            }
            assert.ok(Object.hasOwn(services, name), `Unexpected service: ${name}`);
            return services[name];
        },
    });
    return module.exports;
}

function makePlotViewer(HttpgdViewer) {
    // Use the real rendering methods without opening a device connection.
    return Object.assign(Object.create(HttpgdViewer.prototype), {
        host: plot.host,
        htmlRoot: plotRoot,
        htmlTemplate: fs.readFileSync(path.join(plotRoot, 'index.ejs'), 'utf8'),
        smallPlotTemplate: fs.readFileSync(path.join(plotRoot, 'smallPlot.ejs'), 'utf8'),
        plots: [plot],
        activePlot: plot.id,
        stripStyles: false,
        previewPlotLayout: 'multirow',
        webviewPanel: {
            webview: {
                asWebviewUri: (uri) => ({
                    toString: () => `https://webview.example/${path.basename(uri.fsPath)}`,
                }),
            },
        },
    });
}

for (const minify of [false, true]) {
    describe(`Bundled viewer rendering (${minify ? 'production' : 'development'})`, () => {
        let HttpgdViewer;
        let RLocalHelpPreviewer;

        before(async () => {
            [{ HttpgdViewer }, { RLocalHelpPreviewer }] = await Promise.all([
                loadViewer('src/plotViewer/httpgdViewer.ts', minify),
                loadViewer('src/helpViewer/helpPreviewer.ts', minify),
            ]);
        });

        test('renders the main plot and included thumbnail', () => {
            const viewer = makePlotViewer(HttpgdViewer);
            const html = viewer.makeHtml();
            assert.equal(html.split(plot.data).length - 1, 2);
            assert.ok(html.includes('command:r.plot.showIndex'));
            assert.ok(html.includes('https://webview.example/index.js'));

            viewer.plots = [];
            viewer.activePlot = undefined;
            const emptyHtml = viewer.makeHtml();
            assert.ok(emptyHtml.includes('id="largePlot"'));
            assert.ok(!emptyHtml.includes(plot.data));
        });

        test('renders an added plot thumbnail in the webview message', () => {
            const viewer = makePlotViewer(HttpgdViewer);
            const messages = [];
            viewer.postWebviewMessage = (message) => messages.push(message);
            viewer.focusPlot = async () => {};
            viewer.setContextValues = async () => {};

            viewer.addPlot(plot);

            assert.equal(messages.length, 1);
            assert.equal(messages[0].message, 'addPlot');
            assert.ok(messages[0].html.includes(plot.data));
            assert.ok(messages[0].html.includes('command:r.plot.hidePlot'));
        });

        test('renders a local package index with escaped titles and topic links', async () => {
            const previewer = Object.assign(Object.create(RLocalHelpPreviewer.prototype), {
                indexTemplate: fs.readFileSync(
                    path.join(root, 'src/helpViewer/webview/00Index.ejs'),
                    'utf8',
                ),
                getPackageInfo: () => ({ name: 'example', title: 'A & B', version: '1.0.0' }),
                getAliases: () => [
                    { name: 'example', alias: 'example', title: 'Topic <title>' },
                ],
            });

            const help = await previewer.getHelpFileFromRequestPath(
                '/library/example/html/00Index.html',
            );

            assert.equal(help.isIndex, true);
            assert.equal(help.isPreview, true);
            assert.ok(help.html.includes('A &amp; B'));
            assert.ok(help.html.includes('Topic &lt;title&gt;'));
            assert.ok(help.html.includes('href="example.html"'));
            assert.ok(help.html.includes('version 1.0.0'));
        });
    });
}
