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
        outfile: 'dist/extension.js',
        external: ['vscode', 'utf-8-validate', 'bufferutil'],
        logLevel: 'info',
    });

    // A session agent remains alive after the extension host exits.
    const agentCtx = await esbuild.context({
        entryPoints: ['./src/interactive/agentMain.ts'],
        bundle: true,
        format: 'cjs',
        platform: 'node',
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

    if (watch) {
        await Promise.all([
            extensionCtx.watch(),
            agentCtx.watch(),
            interactiveRendererCtx.watch(),
            webviewCtx.watch()
        ]);
        console.log('Watching for changes...');
    } else {
        await extensionCtx.rebuild();
        await agentCtx.rebuild();
        await interactiveRendererCtx.rebuild();
        await webviewCtx.rebuild();
        await extensionCtx.dispose();
        await agentCtx.dispose();
        await interactiveRendererCtx.dispose();
        await webviewCtx.dispose();
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
