const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function copyResources() {
    const destDir = path.join(__dirname, 'dist', 'resources');
    fs.mkdirSync(destDir, { recursive: true });

    const resources = [
        './node_modules/ag-grid-community/dist/ag-grid-community.min.noStyle.js',
        './node_modules/ag-grid-community/styles/ag-grid.min.css',
        './node_modules/ag-grid-community/styles/ag-theme-balham.min.css',
        './node_modules/@vscode/codicons/dist/codicon.css',
        './node_modules/@vscode/codicons/dist/codicon.ttf',
        './node_modules/@vscode/codicons/LICENSE',
        './node_modules/@vscode/codicons/LICENSE-CODE'
    ];

    for (const res of resources) {
        const srcPath = path.resolve(__dirname, res);
        const destName = path.basename(srcPath);
        const destPath = path.resolve(destDir, destName);
        if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, destPath);
        } else {
            console.warn(`Warning: Resource not found: ${srcPath}`);
        }
    }
    fs.copyFileSync(path.join(__dirname, 'node_modules/webr/LICENSE.md'), path.join(destDir, 'webr-LICENSE.md'));
    const viewerLibrary = fs.readFileSync(path.join(__dirname, 'src/webr/resources/viewer-jsonlite.tgz'));
    fs.writeFileSync(path.join(destDir, 'webr-viewer-jsonlite.json'), JSON.stringify(viewerLibrary.toString('base64')));
    // The detached agent and the browser extension embed the same R viewer
    // helpers as sess. The Node test build reads the generated resource directly.
    const viewerSource = ['dispatch.R', 'handlers.R', 'inspection_call.R', 'interactive_viewers.R']
        .map(file => fs.readFileSync(path.join(__dirname, 'sess', 'R', file), 'utf8'))
        .join('\n');
    fs.writeFileSync(path.join(destDir, 'webr-viewers.json'), JSON.stringify(viewerSource));
    console.log('Resources copied.');
}

function copyWebviewAssets() {
    const views = [
        { name: 'help', src: 'src/helpViewer/webview' },
        { name: 'httpgd', src: 'src/plotViewer/webview' },
        { name: 'webview', src: 'src/webViewer/webview' }
    ];

    for (const view of views) {
        const srcDir = path.join(__dirname, view.src);
        const destDir = path.join(__dirname, 'dist', 'webviews', view.name);
        fs.mkdirSync(destDir, { recursive: true });

        const files = fs.readdirSync(srcDir);
        for (const file of files) {
            if (!file.endsWith('.ts')) {
                fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
            }
        }
    }
    console.log('Webview assets copied.');
}

async function main() {
    // Remove the former standalone iframe bridge left by incremental builds.
    for (const file of ['widget.js', 'widget.js.map']) {
        fs.rmSync(path.join(__dirname, 'dist', 'webviews', 'webview', file), { force: true });
    }
    require('./scripts/prepare-sess').prepareBundledSess();
    copyResources();
    copyWebviewAssets();

    // Extension context (Node)
    const extensionCtx = await esbuild.context({
        entryPoints: ['./src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        alias: { webr: path.resolve(__dirname, 'node_modules/webr/dist/webr.cjs') },
        target: 'node22',
        outfile: 'dist/extension.js',
        external: ['vscode', 'utf-8-validate', 'bufferutil'],
        logLevel: 'info',
    });

    const browserExtensionCtx = await esbuild.context({
        entryPoints: ['./src/web/extension.ts'],
        outfile: 'dist/web-extension.js',
        format: 'cjs',
        platform: 'browser',
        bundle: true,
        // webR's Node entry imports worker_threads. The upstream browser
        // distribution uses a Web Worker with the same JavaScript API.
        alias: { webr: path.join(__dirname, 'node_modules/webr/dist/webr.js') },
        external: ['vscode'],
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
    });

    // A session agent remains alive after the extension host exits.
    const agentCtx = await esbuild.context({
        entryPoints: ['./src/interactive/agentMain.ts'],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        alias: { webr: path.resolve(__dirname, 'node_modules/webr/dist/webr.cjs') },
        target: 'node18',
        outfile: 'dist/interactive-agent.js',
        sourcemap: !production,
        logLevel: 'info',
    });

    const interactiveRendererCtx = await esbuild.context({
        entryPoints: ['./src/interactive/renderer.ts'],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        outfile: 'dist/interactive-renderer.js',
        minify: production,
        sourcemap: !production,
    });

    // Webview context (Browser)
    const webviewCtx = await esbuild.context({
        entryPoints: {
            'help/index': './src/helpViewer/webview/index.ts',
            'httpgd/index': './src/plotViewer/webview/index.ts',
            'webview/index': './src/webViewer/webview/index.ts'
        },
        bundle: true,
        minify: production,
        sourcemap: !production,
        format: 'iife',
        platform: 'browser',
        outdir: 'dist/webviews',
        logLevel: 'info',
    });

    const contexts = [extensionCtx, browserExtensionCtx, agentCtx, interactiveRendererCtx, webviewCtx];
    if (watch) {
        await Promise.all(contexts.map(context => context.watch()));
        console.log('Watching for changes...');
    } else {
        try {
            const results = await Promise.all(contexts.map(context => context.rebuild()));
            if (results.some(result => result.warnings.length > 0)) {
                throw new Error('Build failed because esbuild reported warnings.');
            }
        } finally {
            await Promise.all(contexts.map(context => context.dispose()));
        }
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
