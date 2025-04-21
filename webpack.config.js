//@ts-check

'use strict';

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
    target: 'node', // vscode extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/

    entry: './src/extension.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
    output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
        path: path.resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: 'commonjs2',
        devtoolModuleFilenameTemplate: '../[resource-path]'
    },
    devtool: 'source-map',
    externals: {
        'utf-8-validate': 'commonjs utf-8-validate',
        bufferutil: 'commonjs bufferutil',
        vscode: 'commonjs vscode' // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    },
    resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
        extensions: ['.ts', '.js']
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'ts-loader',
                    }
                ]
            }
        ]
    },
    plugins: [
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        new CopyPlugin({
            patterns: [
                { from: './node_modules/jquery/dist/jquery.min.js', to: 'resources' },
                { from: './node_modules/jquery.json-viewer/json-viewer', to: 'resources' },
                { from: './node_modules/ag-grid-community/dist/ag-grid-community.min.noStyle.js', to: 'resources' },
                { from: './node_modules/ag-grid-community/styles/ag-grid.min.css', to: 'resources' },
                { from: './node_modules/ag-grid-community/styles/ag-theme-balham.min.css', to: 'resources' },
            ]
        }),
    ],
};
