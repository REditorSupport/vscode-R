import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { load } from 'cheerio/slim';
import { AssetStore } from '../../interactive/assets';
import { maxHtmlBytes, validateHtmlBundle, type HtmlBundle } from '../../interactive/htmlBundle';
import { webRWidgetHtml } from '../../webr/widgetHtml';
import { widgetRunner } from '../../webr/widget';

const encode = (text: string) => new TextEncoder().encode(text);
const fixture = (): HtmlBundle => ({
    'index.html': encode(
        '<!doctype html><html><head><script src="libs/widget.js"></script>' +
            '<link rel="stylesheet" media="screen" href="libs/style/main.css"></head>' +
            '<body><script type="application/json">{"value":2}</script><img src="img/plot.png"></body></html>',
    ),
    'libs/widget.js': encode('globalThis.widget = "</script>";'),
    'libs/style/main.css': encode('.widget { background-image: url("../../img/plot.png"); }'),
    'img/plot.png': Uint8Array.of(0, 1, 2, 255),
});

suite('webR HTML widgets', () => {
    test('retains the generated bundle as an ordinary desktop HTML asset', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webr-widget-'));
        try {
            const store = new AssetStore(directory);
            const files = fixture();
            const asset = store.importHtmlFiles(files);
            assert.match(asset, /^[a-f0-9]{64}\/index\.html$/);
            assert.deepEqual(store.read(asset), Buffer.from(files['index.html']));
            assert.deepEqual(
                store.read(asset.replace('index.html', 'libs/widget.js')),
                Buffer.from(files['libs/widget.js']),
            );
            assert.equal(store.importHtmlFiles(files), asset);
            assert.throws(
                () => store.importHtmlFiles({ ...files, '../outside': encode('denied') }),
                /Invalid path/,
            );
            assert.throws(
                () => validateHtmlBundle({ ...files, 'a\\..\\outside': encode('denied') }),
                /Invalid path/,
            );
            assert.throws(() => validateHtmlBundle({ 'file.js': encode('x') }), /index.html/);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('embeds local JS, CSS and its relative binary references without executing them', () => {
        const html = webRWidgetHtml(fixture());
        const $ = load(html);
        assert.equal($('script[src]').length, 0);
        assert.equal($('script').first().text(), 'globalThis.widget = "<\\/script>";');
        assert.equal($('script[type="application/json"]').text(), '{"value":2}');
        assert.equal($('link[href]').length, 0);
        assert.equal($('style').attr('media'), 'screen');
        assert.match($('style').text(), /data:image\/png;base64,AAEC\/w==/);
        assert.equal($('img').attr('src'), 'data:image/png;base64,AAEC/w==');
    });

    test('the host independently bounds retained worker output', () => {
        const files = fixture();
        const piece = new Uint8Array(1024 * 1024);
        for (let i = 0; i < maxHtmlBytes / piece.length; ++i) {
            files['asset-' + i] = piece;
        }
        assert.throws(() => validateHtmlBundle(files), /64 MiB/);
    });

    test('worker capture rejects mounted or linked content and enforces its per-cell budget before sending', async function () {
        this.timeout(30000);
        const { WebR } = await import('webr');
        const runtime = new WebR({ baseUrl: path.dirname(require.resolve('webr')) + path.sep });
        const project = fs.mkdtempSync(path.join(os.tmpdir(), 'webr-widget-project-'));
        const call = `function(dir, id = 1L) webr::eval_js(paste0("globalThis.Module.vscodeRWidget(",
            encodeString(dir, quote='"'), ",", id, ")"))`;
        try {
            fs.writeFileSync(path.join(project, 'private.R'), 'project data');
            await runtime.init();
            await runtime.FS.mkdir('/project');
            await runtime.FS.mount('NODEFS', { root: project }, '/project');
            // Only the transport is needed by this dependency-free worker fixture.
            await runtime.evalRVoid(widgetRunner);
            await runtime.evalRVoid(
                'dir.create("/widget"); writeLines("<p>widget</p>", "/widget/index.html"); file.symlink("/project/private.R", "/widget/data.R")',
            );
            const send = (directory: string) =>
                runtime.evalRString('(' + call + ')(dir)', { env: { dir: directory } });
            assert.match(await send('/widget'), /symlink/);
            await runtime.evalRVoid(
                'unlink("/widget/data.R"); file.symlink("/project", "/widget/subdir")',
            );
            assert.match(await send('/widget'), /symlink/);
            await runtime.evalRVoid('unlink("/widget/subdir"); file.symlink("/project", "/alias")');
            assert.match(await send('/alias'), /Invalid widget directory/);
            assert.match(await send('/project'), /Invalid widget directory/);
            await runtime.evalRVoid(
                'for (i in 1:2500) file.create(file.path("/widget", as.character(i)))',
            );
            // 2501 files fit once. A second send exceeds the aggregate cell budget.
            assert.equal(await runtime.evalRBoolean('!nzchar((' + call + ')("/widget"))'), true);
            assert.match(await send('/widget'), /5000 file limit/);
            assert.equal(await runtime.evalRBoolean('!nzchar((' + call + ')("/widget",2L))'), true);
        } finally {
            runtime.close();
            fs.rmSync(project, { recursive: true, force: true });
        }
    });
});
