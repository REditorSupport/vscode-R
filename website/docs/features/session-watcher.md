# R Session watcher

R session watcher connects vscode-R to a live R session and powers the
workspace and data viewers, session-aware hover and completion, plots, help,
web viewers, and RStudio API emulation.

## Basic usage

The watcher is enabled by default through `r.sessionWatcher`. Run
**R: Create R terminal** to start a managed terminal. vscode-R connects the
session automatically and shows the attached R process in the status bar.

vscode-R 3.0.0 uses the bundled `sess` R package for this connection. If the
package is missing or older than the extension, vscode-R asks whether it may
install or update the bundled version. Managed terminals can reconnect after a
VS Code window reload.

## External and self-managed R sessions

To attach an R process started outside **R: Create R terminal**, run
**R: Attach External R Session (Copy command)** from the Command Palette. This
copies a short `source(...)` command to the clipboard. Run that command in the
target R session.

The generated attach script installs or updates the bundled `sess` package if
needed, then connects that R process to the current VS Code window. This makes
it suitable for R sessions running in `tmux`, `screen`, or another
self-managed terminal. Generate a new command when attaching to a different VS
Code window.

To switch between connected sessions, focus the desired terminal and use the
status bar item or **R: Activate R Session**.

The old `~/.vscode-R/init.R` startup snippet and **R: Attach Active Terminal**
command were removed in v3.0.0. If your `.Rprofile` still sources that file from
a 2.x installation, remove the obsolete `source(...)` block.

## Configuration

Configure session behavior with VS Code settings rather than R
`options(vsc.*)`. In particular:

- `r.session.watchGlobalEnvironment` controls workspace watching and
  session-aware hover and completion.
- `r.session.emulateRStudioAPI` controls RStudio API emulation.
- `r.session.viewers.viewColumn` controls where R webviews open.
- `r.plot.backend` selects the plot backend.

The R-side `vsc.*` options used by vscode-R 2.x are no longer read. See
[Extension settings](../configuration/extension-settings.md)
for the current settings.

## Disabling the watcher

Set `r.sessionWatcher` to `false` and restart or reload VS Code. Features that
require communication with a live R session will then be unavailable.

## How it works

The `sess` package and vscode-R exchange JSON-RPC messages over a local Unix
domain socket on Linux and macOS, or a named pipe on Windows. This replaces the
2.x file-watching protocol based on `request.log`, `globalenv.json`, and
`plot.png`.

Each connected R process has a stable session identity. The extension can work
with multiple sessions, switch the active session, and reconnect managed
terminals after the VS Code window reloads. Session files and local endpoints
are created with owner-only permissions.
