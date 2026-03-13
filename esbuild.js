const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function copyResources() {
    const destDir = path.join(__dirname, 'dist', 'resources');
    fs.mkdirSync(destDir, { recursive: true });

    const resources = [
        './node_modules/jquery/dist/jquery.min.js',
        './node_modules/jquery.json-viewer/json-viewer/jquery.json-viewer.js',
        './node_modules/jquery.json-viewer/json-viewer/jquery.json-viewer.css',
        './node_modules/ag-grid-community/dist/ag-grid-community.min.noStyle.js',
        './node_modules/ag-grid-community/styles/ag-grid.min.css',
        './node_modules/ag-grid-community/styles/ag-theme-balham.min.css'
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

async function main() {
    copyResources();

    const ctx = await esbuild.context({
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

    if (watch) {
        await ctx.watch();
        console.log('Watching for changes...');
    } else {
        await ctx.rebuild();
        await ctx.dispose();
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
