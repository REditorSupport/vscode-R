# Contributing to vscode-r

If you are interested in writing code to fix issues, please see [How to Contribute](https://github.com/REditorSupport/vscode-R/wiki/Contributing) in the wiki.

## Debugging the extension

1. Run `pnpm install` and open this repository in VS Code.
2. Select **Launch Extension** in Run and Debug, then press **F5**. The pre-launch task runs `pnpm run compile` to build the extension and webviews in `dist`, including source maps for TypeScript breakpoints.
3. Open an R file or run an R command in the Extension Development Host to activate vscode-R. Ensure the **R Syntax** extension (`REditorSupport.r-syntax`) is installed and enabled there.

For continuous rebuilding, run `pnpm run watch`. `pnpm run build` additionally installs the bundled `sess` R package; this is not required just to launch the extension debugger. **Extension Tests** builds both the bundle and the TypeScript test files before launching.

VS Code 1.139 has a [JavaScript debugger regression](https://github.com/microsoft/vscode-js-debug/issues/2420) that can leave the development host paused before any extension activates. The launching window's extension host log shows `ECONNREFUSED ::1` and `Could not find any debuggable target`. The fix is included in [JavaScript Debugger 1.140](https://github.com/microsoft/vscode-js-debug/releases/tag/v1.140.0). Until your VS Code version includes it, use Microsoft's [JavaScript Debugger Nightly](https://marketplace.visualstudio.com/items?itemName=ms-vscode.js-debug-nightly): disable the built-in **JavaScript Debugger**, install Nightly, and reload VS Code. Switch back to the built-in debugger once VS Code includes the fix.
