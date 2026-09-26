# Changelog

## Unreleased

v3.0.0 of the R Extension for VS code is a major release. It introduces a
significant architectural change via the
[**`sess`**](https://github.com/REditorSupport/vscode-R/tree/master/sess) R
Package, which powers faster and more robust communication with the underlying R
session. In turn, this enables a variety of ancillary improvements and feature
requests, which we hope to continue building on. The extension will
automatically prompt users to install `sess` (on their behalf) if it is not
detected.

### Bug Fixes

* fix(sess): refresh JGD renderer discovery on reconnect and identify managed terminals by discovery ownership

* fix(sess): reconnect managed R sessions after window reload and prioritize manual recovery of the selected R terminal

* fix(rstudioapi): resolve emulation issues and viewer routing
* fix(liveshare): resolve activation errors, file reading bugs, and add hooks for sess compatibility
* fix(workspace): fix code submission delays when the workspace contains many or large objects

### Features

* feat(sess): migrate session watcher to WebSockets/JSON-RPC 2.0
* feat: implement rstudioapi::showPrompt() and rstudioapi::askForPassword() for sess package
* feat: evaluate params from YAML header in Rmd files before running code
* feat: check sess package version and prompt for update
* feat(session): implement file-based reconnection and suppress verbose logs
* feat(plot): new `r.plot.backend` enum setting for finer-grained control of the preferred plotting backend, including integration with the lightweight `jgd` graphics device (default if installed). `r.plot.useHttpgd` is deprecated in favor of `r.plot.backend`; it remains supported for compatibility with existing configurations but will be removed in a future release.
* feat(r-path): add `r.executablePath` as the canonical setting for vanilla R used by background processes and `r.consolePath` for the interactive R console. Both accept an absolute or substituted path, or a bare executable name available on `PATH`; for example, `r.executablePath` can be the bare vanilla executable name `R`, while `r.consolePath` can be `arf` (or `radian`). Path settings are resolved against the relevant workspace resource when one is available. When `r.consolePath` and the legacy `r.rterm.<platform>` setting are unset, an explicitly configured `r.executablePath` is also used for the console. The legacy `r.rpath.<platform>` settings never affect console selection. The legacy `r.rpath.<platform>` and `r.rterm.<platform>` settings are deprecated in favor of the canonical settings, remain supported for backward compatibility, and may be removed in a future release.
* feat(dataview): keep one viewer per data name, refreshing the existing viewer on repeated `View()` calls
* feat(dataview): load data rows on demand while scrolling, with support for Arrow and Polars DataFrames
* feat(workspace): support recursive expansion of nested lists, environments, pairlists, S4 objects, and data frames

### Performance

* perf: optimize package monitoring in helpServer.R

### Other

* Remove the unused `r.workspaceViewer.showObjectSize` setting and obsolete object-size tooltip support
* Remove obsolete `r.session.objectLengthLimit`, `r.session.objectTimeout`, and `r.session.levelOfObjectDetail` settings following the switch to on-demand workspace inspection
* Remove `r.helpPanel.rpath`, which was previously deprecated and no longer used by the extension

### Styling

* style: fix line length lint error in sess/R/rstudioapi.R

### Testing

* test: implement comprehensive integration test suite and modernize CI
* test: add Rmd params tests and cleanup test files
* test(session): add retry logic for plot tests to avoid timeouts on Windows
* test(session): add version check, retry logic, and fix lint warnings

## 2.8.8 - 2026-03-24

### Features

* feat: change default of r.lsp.multiServer to false

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.8.7...v2.8.8>

## 2.8.7 - 2026-03-15

### Bug Fixes

* fix: correct r.term and r.path setting names in error message

### Features

* feat: support multi-root workspaces in single-server mode

### Other

* Allow bracketedPaste on win32 platform ([#1631](https://github.com/REditorSupport/vscode-R/issues/1631))
* feat: default to single language server for multi-root workspaces ([#1682](https://github.com/REditorSupport/vscode-R/issues/1682))

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.8.6...v2.8.7>

## 2.8.6 - 2025-05-31

### Other

* Syntax update and bump to 2.8.6 ([#1605](https://github.com/REditorSupport/vscode-R/issues/1605))
* Show sidebar icon only when extension is active ([#1579](https://github.com/REditorSupport/vscode-R/issues/1579))
* Move R and R markdown syntaxes to vscode-R-syntax ([#1606](https://github.com/REditorSupport/vscode-R/issues/1606))

### Refactor

* refactor: restructure files ([#1613](https://github.com/REditorSupport/vscode-R/issues/1613))

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.8.5...v2.8.6>

See [CHANGELOG.old.md](https://github.com/REditorSupport/vscode-R/blob/master/CHANGELOG.old.md) for changes before v2.8.5.

<!-- generated by git-cliff -->
