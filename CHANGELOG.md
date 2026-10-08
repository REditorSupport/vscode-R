# Changelog

## Unreleased

- Focus the terminal created from the "R Terminal" profile (the terminal panel's "+" menu). VS Code focuses "the last terminal" before a contributed-profile terminal is registered, so with a remote extension host (Codespaces, SSH, vscode.dev) the new R terminal opened without focus, unlike "R: Create R Terminal". The extension now shows the terminal it provided.

## 3.0.1 - 2026-09-28

- Bump version of both the extension and `sess` to `3.0.1` so users who installed an earlier `3.0.0` pre-release build of `sess` (before its connection protocol was finalized) are prompted to reinstall `sess`. (#1794)

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v3.0.0...v3.0.1>

## 3.0.0 - 2026-09-27

`v3.0.0` of the R Extension for VS Code is a major release. It introduces a
significant architectural change via the (new)
[**`sess`**](https://github.com/REditorSupport/vscode-R/tree/main/sess) R
package, which powers faster and more robust communication with the underlying R
session. In turn, this has allowed us to close numerous long-standing bugs, as
well as enable a variety of ancillary improvements and feature requests. The
extension bundles its own copy of `sess` and will offer to install it (on your
behalf) if it is missing or outdated. See the
[`sess`
README](https://github.com/REditorSupport/vscode-R/tree/main/sess#readme) for
more details.

### Highlights

- **More reliable R sessions:** Session communication now uses `sess` with
  local sockets or named pipes. Managed R sessions can reconnect after a VS
  Code window reload, and workspace updates no longer delay code submission
  when the environment contains large objects.
- **More flexible plot viewing:** `r.plot.backend` selects `jgd`, `httpgd`, or
  the standard graphics device. Automatic selection prefers `jgd` when
  installed, then `httpgd`, then the standard device.
- **Faster, more capable data and workspace viewers:** Data rows and workspace
  objects load on demand, including Arrow and Polars data frames in the data
  viewer, which also gains column controls, filtering, and row counts.
- **R Markdown and RStudio API:** YAML parameters are evaluated before running
  R Markdown code, and `rstudioapi::showPrompt()` and
  `rstudioapi::askForPassword()` are now supported.
- **Improved console configuration:** Console and background R executables can
  be set separately, including executable names found on `PATH`.

### Breaking changes

- **VS Code 1.110 or later is now required.**
- The session watcher has been rewritten around the new `sess` package, which
  replaces the R scripts that previously lived under `~/.vscode-R/`. The
  extension and R now talk over a local socket (Unix) or named pipe (Windows),
  rather than by watching files. For most users, this change should be
  invisible apart from being faster and more reliable. However, users who
  customized the old session watcher should note the following:
  - The R-side `vsc.*` options (e.g., `vsc.plot`, `vsc.viewer`, `vsc.browser`,
    `vsc.row_limit`) are no longer read. Use the equivalent `r.*` VS Code
    settings instead.
  - The `~/.vscode-R/init.R` script and the **R: Attach Active Terminal**
    command have been removed.
- Live Share integration has been removed, including its commands and
  `r.liveShare.*` settings. (#1684 @randy3k)
- Several settings that no longer had any effect have been removed:
  `r.helpPanel.rpath`, `r.session.useWebServer`, `r.session.data.rowLimit`
  (superseded by on-demand loading in the data viewer), `r.session.objectLengthLimit`,
  `r.session.objectTimeout`, `r.session.levelOfObjectDetail`, and
  `r.workspaceViewer.showObjectSize`. (#1713, #1734 @Fred-Wu, #1762 @eitsupi)

### Renamed settings

Several settings have been given clearer, platform-independent names. The old
names are deprecated but still work, so existing configurations will continue
to behave as before. If both are set, the new name takes precedence (within the
same user/workspace scope).

| Old (deprecated)       | New                   |
|------------------------|-----------------------|
| `r.rpath.<platform>`   | `r.executablePath`    |
| `r.rterm.<platform>`   | `r.consolePath`       |
| `r.rterm.option`       | `r.consoleArgs`       |
| `r.rtermSendDelay`     | `r.consoleSendDelay`  |
| `r.plot.useHttpgd`     | `r.plot.backend`      |

(#1733, #1735, #1762 @eitsupi)

### New features

#### Plot viewer

- New `r.plot.backend` setting for choosing the plot viewer: `"standard"`,
  `"httpgd"`, `"jgd"`, or `"auto"` (the default). The latter picks the best
  available backend, trying [jgd](https://github.com/REditorSupport/jgd) first
  (see next bullet), then httpgd, then the standard viewer. Changes should take
  effect without reloading VS Code, and you'll get a warning if the requested
  backend isn't installed. This supersedes the old `r.plot.useHttpgd` setting,
  which is deprecated but still respected (see "Renamed settings" above).
  (#1706, #1716, #1766 @grantmcdermott, #1733 @eitsupi)
- Native integration with the lightweight `jgd` graphics device, including
  plot history and export. Only the `jgd` R package is needed; no separate VS
  Code extension required. See the `r.plot.jgd.*` settings for history and
  export options. (#1706 @grantmcdermott)
- The standard plot viewer now re-renders plots to fit the viewer panel as it
  is resized, rather than displaying a fixed-size image. It also produces
  crisp SVG output by default if the `svglite` package is installed, falling
  back to PNG otherwise. Use the new `r.plot.format` setting to choose
  explicitly. (#1684 @randy3k)
- Plot navigation commands (next, previous, zoom, export, etc.) are now hidden
  from the Command Palette, since they only apply to an open plot viewer. They
  remain available from the viewer toolbar. (#1762 @eitsupi)

#### R executable and console

- `r.executablePath` sets the R used for background tasks (e.g., the help
  server and package installation), while `r.consolePath` sets the interactive
  console. The latter makes it easy to use alternative consoles like
  [arf](https://github.com/eitsupi/arf) or
  [radian](https://github.com/randy3k/radian). Both accept either a full path
  or a bare command name on your `PATH` (e.g., `"R"` or `"arf"`), and support
  variables like `${workspaceFolder}`. If `r.consolePath` is unset,
  `r.executablePath` is used for the console too. (#1735, #1762 @eitsupi)

#### Data viewer

- Much faster for large datasets. Rows are loaded on demand as you scroll,
  rather than all at once. Arrow tables and Polars DataFrames are also
  supported. (#1703 @renkun-ken, #1717 @Fred-Wu)
- New column panel to search, show/hide, and pin columns, plus inline filters,
  a "clear all filters" button, row counts, and full-value tooltips. Columns
  fit the viewer width by default, and your view settings are remembered.
  (#1747 @Fred-Wu, #1765 @renkun-ken)
- Calling `View()` on the same object again refreshes the existing viewer tab,
  instead of opening a new one. The viewer also keeps its column layout if the
  column names, order, and types are unchanged. (#1707 @Fred-Wu, #1765
  @renkun-ken)

#### Workspace viewer

- Nested objects (lists, environments, pairlists, S4 and R6 objects, data
  frames) can now be expanded recursively. Large objects load 500 items at a
  time, with a "..." row to load more. (#1713, #1730 @Fred-Wu)

#### Session

- R terminals now reconnect automatically after reloading the VS Code window.
  (#1764 @eitsupi)

#### Other

- `rstudioapi::showPrompt()` and `rstudioapi::askForPassword()` are now
  supported. (#1684 @randy3k)
- R Markdown `params` from the YAML header are now evaluated before running
  code chunks. (#1684 @randy3k)
- The extension now activates when an R or R Markdown file is opened, not just
  when a workspace contains one. (#1768 @ThomasSoeiro)
- New R documentation files default to the `.Rd` extension. (#1773
  @ThomasSoeiro)

### Bug fixes

- Fixed lag when sending code to the console while the workspace contains many
  or large objects. (#1713, #1720 @Fred-Wu)
- The data viewer no longer displays very small numbers as `0`. (#1738, #1757
  @Fred-Wu)
- Fixed various `rstudioapi` emulation issues, including viewer routing.
  (#1684 @randy3k)
- Removed the spurious "No text editor active" warning. (#1704 @renkun-ken)
- The help viewer no longer disables TLS certificate validation when fetching
  from CRAN. (@tomaioo)
- Session files are now created with owner-only permissions. (#1705
  @renkun-ken)
- `r.session.viewers.viewColumn.helpPanel` is now respected for help pages
  opened from R, including `"Disable"`. (#1762 @eitsupi)
- Language server diagnostics now ignore virtual and deleted files.
  (#1697 @toscm)
- When the session watcher is disabled, the warning now links to the relevant
  setting rather than an empty wiki page. (#1760 @Fred-Wu)

### Internals

- New integration test suite. (#1684 @randy3k)
- Modernized CI, including Node.js 24, updated GitHub Actions, and Dependabot
  updates for workflow dependencies. (#1731, #1771 @eitsupi)
- The `sess` R tests use
  [tinytest](https://github.com/markvanderloo/tinytest). (#1706
  @grantmcdermott)

### Organization

- New maintainers with write access: @eitsupi, @Fred-Wu, and @grantmcdermott.
- The [jgd](https://github.com/REditorSupport/jgd) graphics device package
  has joined the REditorSupport organization.
- REditorSupport now has its own
  [R-universe](https://reditorsupport.r-universe.dev), providing up-to-date
  (dev) binary builds of our various R packages.
- The default branch has been renamed from `master` to `main`. Contributors
  should update their local clones and target `main` in pull requests.
  (#1103, #1775 @randy3k)

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.8.8...v3.0.0>

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
