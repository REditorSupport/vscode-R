# Contributing to vscode-r

If you are interested in writing code to fix issues, please see [How to Contribute](https://github.com/REditorSupport/vscode-R/wiki/Contributing) in the wiki.

## Debugging the extension

Use Node.js 22.13 or newer (CI uses Node.js 24) and the pnpm version declared in `package.json`. Install pnpm before running the repository commands:

```sh
npm install --global pnpm@11.27.1
pnpm --version
```

If a command reports `pnpm: command not found`, ensure pnpm's installation directory is on `PATH` and restart the terminal or VS Code. Use pnpm for repository commands; dependency installation and CI use the checked-in `pnpm-lock.yaml` and `pnpm-workspace.yaml` build-script policy.

1. Run `pnpm install --frozen-lockfile` and open this repository in VS Code.
2. Select **Launch Extension** in Run and Debug, then press **F5**. The pre-launch task runs `pnpm run compile` to build the extension and webviews in `dist`, including source maps for TypeScript breakpoints.
3. Open an R file or run an R command in the Extension Development Host to activate vscode-R. Ensure the **R Syntax** extension (`REditorSupport.r-syntax`) is installed and enabled there.

For continuous rebuilding, run `pnpm run watch`. `pnpm run build` additionally installs the bundled `sess` R package; this is not required just to launch the extension debugger. **Extension Tests** builds both the bundle and the TypeScript test files before launching.

VS Code 1.140.0 bundles [JavaScript Debugger 1.140.0](https://github.com/microsoft/vscode-js-debug/releases/tag/v1.140.0), which fixes the [extension host attach regression in VS Code 1.139](https://github.com/microsoft/vscode-js-debug/issues/2420). Use the built-in **JavaScript Debugger** on VS Code 1.140.0 or newer. If you previously used **JavaScript Debugger Nightly**, disable Nightly, re-enable the built-in debugger (`ms-vscode.js-debug`) in the Extensions view, and run **Developer: Reload Window**.

If launching reports `Configured debug type 'extensionHost' is not supported`, ensure the built-in **JavaScript Debugger** is enabled in the launching window's profile and workspace. Disabling Nightly does not automatically re-enable the built-in debugger. To find it, search for `@builtin @id:ms-vscode.js-debug` in the Extensions view, select **Enable** (or **Enable (Workspace)** if it was disabled only for this workspace), and reload the window.

On VS Code 1.139, the regression can leave the development host paused before any extension activates; the launching window's extension host log shows `ECONNREFUSED ::1` and `Could not find any debuggable target`. Upgrade to VS Code 1.140.0 or newer, or use Microsoft's [JavaScript Debugger Nightly](https://marketplace.visualstudio.com/items?itemName=ms-vscode.js-debug-nightly) as a temporary workaround: disable the built-in **JavaScript Debugger**, enable Nightly, and reload VS Code.

## Formatting and linting

Run `pnpm run format` to format all files supported by Oxfmt, and
`pnpm run format:check` to check formatting without changing files. CI runs the
same check for pull requests and pushes to `main`.

The checked-in `.oxfmtrc.jsonc` is shared by the CLI and the recommended Oxc
VS Code extension. JavaScript and TypeScript use four-space indentation and
single quotes; other supported formats use two-space indentation. Import and
`package.json` sorting are disabled. Oxfmt respects the repository's `.gitignore`
files and skips dependency lockfiles, so generated bundles, compiled tests, and
dependencies are excluded. R, C, and EJS files are outside Oxfmt's supported
formats.

Workspace settings select Oxc as the formatter and enable format on save for
JavaScript, TypeScript, JSON/JSONC, CSS, HTML, Markdown, YAML, and TOML. Run
`pnpm run lint` and `pnpm run typecheck` separately to check TypeScript code.

## Building bundled sess

Builds require Git and a checkout with HEAD. `scripts/prepare-sess.js` fingerprints
`sess/` using a temporary Git index and exports the same snapshot to
`dist/resources/sess/`, excluding untracked ignored files. It stamps only the
generated DESCRIPTION; source files and the developer's index remain unchanged.
A clean checkout matches `HEAD:sess`, so extension-only changes retain the identity.

Compile and VSIX packaging prepare this copy, and `pnpm run build` installs it.
Watch mode prepares it at startup; restart the watcher after editing `sess/`.
R-universe's `sess/bootstrap.R` produces the same identity from committed sources.
Source DESCRIPTION enables pkgbuild's bootstrap hook; the prepared copy disables
it to avoid repeating preparation when installed through remotes.

`Config/vscode-R/source-revision` controls installation independently of package
versions and the runtime `protocol_version` handshake. Missing or different
installed metadata requires the bundle; installation verifies it is visible
through `.libPaths()`. Run the lightweight checks with `pnpm run test:sess-source`.

## Testing R Interactive

The [architecture and backend contract](src/interactive/README.md) live beside the implementation. User setup and behavior belong in the [R Interactive wiki page](https://github.com/REditorSupport/vscode-R/wiki/R-Interactive).

Use Linux or macOS for native Interactive runtime tests, with R and a C compiler for R packages. Windows runs the remaining extension checks but does not support the native Interactive console bridge. From the repository root, after installing pnpm dependencies, prepare a test library:

```sh
export R_LIBS=/path/to/test-library
mkdir -p "$R_LIBS"
Rscript -e 'install.packages(c("remotes", "languageserver", "lintr", "renv"))'
pnpm run build
Rscript -e 'tinytest::test_package("sess")'
```

`pnpm run build` installs the bundled sess and its dependencies, including suggested packages, into the selected R library. JGD checks need `jgd` and `systemfonts`; standard graphics uses `svglite` or PNG. Runtime suites build private bridge installations and use disposable sessions/libraries. Keep `R_LIBS` set for the commands below.

```sh
pnpm run test:interactive
VSCR_TEST_PROVIDER=arf ARF_PATH=/path/to/arf pnpm run test:interactive
VSCR_TEST_STATIC=1 pnpm run test:interactive
VSCR_TEST_TMUX=1 pnpm run test:interactive
```

The default provider is plain R. The arf run needs an installed arf executable; `VSCR_TEST_STATIC=1` selects standard graphics. The tmux variant needs tmux and exercises a real supervised agent, as Linux CI does. These variables can be combined. Check skipped tests when assessing coverage: a missing optional runtime or package is not a verified pass for that feature.

For VS Code integration, compile the tests and run the editor suite, or use `pnpm run test` for the full extension suite:

```sh
pnpm run pretest
pnpm exec vscode-test --run out/test/suite/interactiveEditor.test.js
```

On headless Linux, run the editor command under `xvfb-run -a`. The test configuration installs R Syntax in the test profile. [runtime-lifecycle.cjs](src/test/examples/README.md#editor-runtime-lifecycle) separately checks persistence across full application exit and different editor versions. Use it with the minimum VS Code version from `package.json` and current stable when changing runtime launch or reconnection.

### Browser renderer

After `pnpm run compile`, serve the repository from its root, for example:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

Open <http://127.0.0.1:8765/src/test/browser/interactiveRenderer.html>. The harness checks table paging/filtering, stale responses/retries, offline controls, plot export, Unicode SVG, menu disposal, image failures, and sandboxed HTML. Repeat with `?theme=light&width=narrow` and `?theme=contrast`; verify native Tab/Shift+Tab navigation and Enter/Space activation manually. Execution success alone does not establish rendering or widget interaction.

### Analysis and remote lifecycle checks

The [analysis fixtures](src/test/examples/README.md) document public/research examples, reference plots, widget checks, and large-table allocation measurements. Keep repeatable procedures there; record dated results and environment-specific limitations in the PR discussion.

For changes to persistence or supervision, also exercise the intended Remote SSH host: create managed plain-R and arf sessions, adopt an existing terminal arf, create distinct objects, and submit jobs that stream text and plots. Close VS Code and disconnect SSH during execution, then reconnect. Verify the same R PIDs and objects, retained output, session isolation, usable plots, and no duplicate evaluation. Check that the adopted terminal remains usable and that stop/restart targets only the selected session. Local process tests do not establish server-specific logout, systemd, or network behavior.
