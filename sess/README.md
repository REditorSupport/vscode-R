# sess — A high-performance IPC bridge for R sessions

<!-- badges: start -->

<a href="https://reditorsupport.r-universe.dev"><img src="https://reditorsupport.r-universe.dev/badges/sess" class="img-fluid" alt="R-universe version"></a>

<!-- badges: end -->

`sess` is an R package for connecting your R sessions to an editor (client). The
[VS Code R extension](https://github.com/REditorSupport/vscode-R) is our primary
target client and `sess` powers many of the extension's core features:
workspace, data and plot viewers, help panel, hover and completion, RStudio API
emulation, etc.

Under the hood, `sess` talks to the client over a local socket (Unix domain
socket on macOS/Linux, named pipe on Windows) using
[JSON-RPC 2.0](https://www.jsonrpc.org/specification) messages.

## Installation

> [!NOTE]
>
> ### Bundled install for VS Code
>
> Users of the VS Code R extension (>=v3.0.0) do not need to install `sess`
> manually. The extension bundles its own copy of `sess` and will install it
> for you (along with any missing CRAN dependencies) if it is missing or
> outdated. Managed R terminals ask first; attaching an existing session
> installs without prompting.

`sess` is not yet on CRAN. But you can install the development version from R-universe:

```r
install.packages(
  "sess",
  repos = c("https://reditorsupport.r-universe.dev", getOption("repos"))
)
```

## Usage

When you start an R terminal from VS Code, the extension's R profile calls
`sess::connect()` for you. To connect a session yourself:

```r
sess::connect(
  endpoint = NULL,       # socket/pipe endpoint; see below
  use_rstudioapi = TRUE, # emulate rstudioapi functions
  use_httpgd = TRUE,     # allow httpgd as the plot device
  use_jgd = FALSE        # allow jgd as the plot device
)
```

If `endpoint` is omitted, `connect()` resolves it in this order:

1. The `SESS_ENDPOINT` environment variable.
2. The `endpoint` field of the JSON file named by `SESS_DISCOVERY_FILE`.

The discovery file must have integer schema version `1` and a nonempty `endpoint`.
When discovery is needed, a missing, invalid, or unsupported file prevents connection.
An explicit endpoint or `SESS_ENDPOINT` takes precedence over discovery.

If the discovery file describes the connected endpoint, unexpected disconnection
starts a retry loop. It waits for a different endpoint and reconnects with the same
runtime options and process-lifetime `session_id`. A manual `connect()` cancels
pending retries. Each managed terminal has its own discovery file in extension
storage; VS Code refreshes it after reload, using extension-private terminal PID
metadata even when a wrapper's PID differs from R's. Unknown fields are ignored.

### Discovery schema and extensions

```json
{"version":1,"endpoint":"/path/to/sess.sock","jgdSocket":"/path/to/jgd.sock"}
```

Only `version` and `endpoint` are required. Consumers must ignore unknown fields.
New backends may add optional fields under version `1`: adding a field does not
require a schema version bump. Removing or changing the meaning/type of existing
fields, or making additional fields mandatory, is a breaking change and requires
a new schema version. This discovery schema version is separate from the IPC
`protocol_version`.

The optional `jgdSocket` string describes the JGD renderer belonging to that
endpoint. When `use_jgd = TRUE`, `sess` applies it before runtime initialization,
including automatic reconnect: a nonempty string sets `JGD_SOCKET`, an empty
string unsets it (renderer unavailable), and an omitted field leaves it untouched.
A present value of another type is invalid. It does not enable JGD or override
`use_jgd`; no arbitrary environment variables or R code are accepted. VS Code
publishes endpoint and renderer together in one atomic file replacement, with
an empty `jgdSocket` when its current backend does not provide JGD.

Fields belonging to other backends remain optional and are interpreted only by
implementations that support them. `terminalPid` is VS Code-private metadata for
finding managed terminal discovery files; `sess` does not use it as identity.

## What `sess` changes in your R session

Once connected, `sess` registers hooks (via `register_hooks()`) that redirect
R's interactive features to the client:

| R feature | Behavior |
|---|---|
| `View()` | Data frames, matrices, Arrow tables and polars data frames open in a paged, sortable, filterable data viewer. Lists open as JSON; other objects as R code. |
| `browseURL()`, `viewer`, `page_viewer` | URLs and local HTML files (e.g. htmlwidgets) open in the editor. |
| `?topic`, `help.search()` | Help pages open in the editor's help panel, in the column configured by `r.session.viewers.viewColumn.helpPanel`. |
| Graphics device | Plots appear in the editor's plot viewer (see below). |
| `rstudioapi` | Editor functions such as `getActiveDocumentContext()` and `insertText()` are emulated when `use_rstudioapi = TRUE`. |
| Top-level task callback | The client is notified after each command so it can refresh the workspace view. |

These changes are undone when the connection closes. `sess` removes its task
callbacks, closes its graphics devices, and restores any options, bindings, S3
methods and plot hooks it replaced (unless other code has since changed them).
A plot held only by a jgd device may not survive a disconnect or window reload.
Calling `register_hooks()` again replaces the previous installation rather than
stacking hooks.

### Graphics devices

For displaying R plots, `sess` chooses a graphics device in this order:

1. **jgd**, if `use_jgd = TRUE`, the `JGD_SOCKET` environment variable is set,
   and the [jgd](https://cran.r-project.org/package=jgd) package is installed.
2. **httpgd**, if `use_httpgd = TRUE` and the
   [httpgd](https://cran.r-project.org/package=httpgd) package is installed.
3. **Standard**: plots are recorded on a null device and re-rendered by the
   client on demand at the viewer's size (as SVG via
   [svglite](https://cran.r-project.org/package=svglite) if installed,
   otherwise PNG).

In VS Code, this is controlled by the `r.plot.backend` setting.

### Options and environment variables

| Name | Type | Purpose |
|---|---|---|
| `SESS_ENDPOINT` | env var | Socket/pipe path used by `connect()`. |
| `SESS_RSTUDIOAPI` | env var | `TRUE`/`FALSE`; passed as `use_rstudioapi` by the extension's R profile. |
| `SESS_PLOT_BACKEND` | env var | `auto`, `standard`, `httpgd` or `jgd`; sets `use_httpgd`/`use_jgd` in the extension's R profile. |
| `JGD_SOCKET` | env var | Socket used by the jgd device; set by the extension. |
| `sess.quiet` | R option | Set to `TRUE` to suppress the successful connection message. Connection failures remain visible. |

## Source identity and installation

`Version` is the R package version, not an extension deployment identifier. The
extension checks `Config/vscode-R/source-revision` in the installed DESCRIPTION
against its bundled copy. A missing, invalid or different revision requires
installing the bundle, including when switching from pre-release back to stable
or when two builds have the same package version. Older installations without
this field migrate by installing the bundled copy once. A bundle with an
unexpanded placeholder is a build error; version comparison is not a fallback.

The field is committed as `@VSCODE_R_SESS_SOURCE_REVISION@`. Every esbuild entry
(compile, watch startup and production/VSIX packaging) prepares a generated copy
at `dist/resources/sess/`, where the placeholder becomes `git-tree:<object ID>`.
`scripts/prepare-sess.js` fingerprints the `sess/` working tree using a temporary
Git index, restoring the placeholder for the calculation. It includes new,
modified and deleted source files without changing the user's index or source
files. The generated directory is recreated to remove obsolete files. The
extension installs from this directory, and only this copy is included in the
VSIX. For a clean checkout this is exactly `git rev-parse HEAD:sess`; extension
changes outside `sess/` do not cause another installation. The repository's
`.gitattributes` keeps text checkouts at LF across platforms, including when
`core.autocrlf` is enabled. Git normalizes a developer's
CRLF edits before calculating the snapshot. Git and a checkout with HEAD are
required to build the extension. The tracked DESCRIPTION keeps its placeholder;
compiling or packaging does not dirty the source tree. Watch mode prepares the
copy at startup; restart the build after editing `sess/` sources. Both build
paths write stamped DESCRIPTION files with LF endings.

R-universe runs `sess/bootstrap.R` from the package directory. It replaces the
same placeholder with the committed package subtree ID, before R CMD build,
and the field survives into source and binary packages. The build service first
normalizes DESCRIPTION and may add `Config/pak/sysreqs`; these generated changes
are excluded from source identity. Bootstrap requires committed sources and
rejects other source/description edits. Local development VSIXs instead identify
their actual working tree. Since R-universe ignores bootstrap failures, the
script resets any previous stamp to the placeholder before doing Git work. CI
runs bootstrap explicitly, checks agreement with the prepared VSIX copy after
DESCRIPTION normalization, checks R CMD build preserves the field, and validates both the
installed package and packaged VSIX. Run these lightweight tests with
`pnpm run test:sess-source` (Node, Git and base R only).

`R/sess_source.R` shares the installed-package lookup and install decision between
the prompt, attach command and installer. It reads DESCRIPTION from `.libPaths()`
without loading the namespace. After installation, the installer verifies that
the visible package has the expected revision; warnings or a shadowing library
must not silently count as success. Updating files does not replace a namespace
already loaded in R: restart that R process to use the new source. On platforms
that prevent overwriting loaded packages, restart before installing.

Source identity is deployment metadata. It does not describe a running
namespace or determine whether a session can connect. The existing
`protocol_version` handshake remains responsible for runtime compatibility;
source mismatches do not reject an otherwise compatible running session.

## Protocol reference

This section is for developers writing or debugging a client.

### Transport and framing

- **Transport:** Unix domain socket (macOS/Linux) or named pipe (Windows).
  `sess` is the connecting side; the client listens.
- **Framing:** [JSON Lines](https://jsonlines.org/). Each message is one
  JSON-RPC 2.0 object followed by `\n`. Receivers buffer incoming data and
  dispatch complete lines only.
- **Messages:** standard JSON-RPC 2.0 notifications (no `id`), requests (with
  `id`) and responses (`result` or `error`). Unknown request methods receive
  error `-32601` (`Method not found`).
- **Coordinates:** row and column positions in `rstudioapi/*` messages are
  1-indexed, as in R.

### Handshake

On connecting, `sess` sends an `attach` notification:

```json
{
  "jsonrpc": "2.0",
  "method": "attach",
  "params": {
    "protocol_version": 1,
    "sess_version": "3.0.0",
    "session_id": "sess-session-...",
    "host": "compute42",
    "version": "4.5.0",
    "pid": 12345,
    "tempdir": "/tmp/Rtmp.../sess",
    "wd": "/path/to/project",
    "info": {
      "command": "/usr/bin/R",
      "version": "R version 4.5.0 (...)",
      "start_time": "2026-05-05 06:00:00"
    }
  }
}
```

`protocol_version` versions the message contract independently of the R package
version. The extension rejects unsupported versions. `session_id` identifies an
R process across reconnects; PID and host are metadata, not connection identity.
The attached socket's lifetime controls cleanup. A replacement socket with the
same identity supersedes the old one; a late close cannot remove its replacement.
A fork child receives its own identity. Terminal PID association is local-only.

### Notifications from R to client

Sent with `notify_client()`.

| Method | Params | Sent when |
|---|---|---|
| `attach` | see above | Connection is established. |
| `workspace_updated` | none | A top-level command completes. |
| `dataview` | `title`, `source`, `type`, and `view_id` (tables) or `file` (other objects) | `View()` is called. |
| `plot_updated` | none | The standard device records a new or changed plot. |
| `httpgd` | `url` | An httpgd device is opened. |
| `help` | `requestPath` | A help page or help search is printed. |
| `browser` / `webview` / `page_viewer` | `url` | The corresponding R viewer option is invoked. |
| `restart_r` | `command`, `clean` | `rstudioapi::restartSession()` is called. |
| `rstudioapi/send_to_console` | `code`, `execute`, `focus`, `animate` | `rstudioapi::sendToConsole()` is called. |

### Requests from R to client

Sent with `request_client()`, which blocks until the matching response
arrives. All are used by `rstudioapi` emulation:

`rstudioapi/active_editor_context`, `rstudioapi/document_context`,
`rstudioapi/insert_or_modify_text`,
`rstudioapi/replace_text_in_current_selection`,
`rstudioapi/set_selection_ranges`, `rstudioapi/navigate_to_file`,
`rstudioapi/document_new`, `rstudioapi/document_save`,
`rstudioapi/document_save_all`, `rstudioapi/document_close`,
`rstudioapi/get_project_path`, `rstudioapi/show_dialog`,
`rstudioapi/ask_for_password`.

### Requests from client to R

| Method | Params | Result |
|---|---|---|
| `workspace` | none | `globalenv` (objects with `class`, `type`, `length`, ...), `search`, `loaded_namespaces` |
| `workspace_children` | `name`, `path`, `start` | `children`, `next_start` (paged expansion of lists, environments, S4/R6 objects) |
| `hover` | `expr` | `str`: the `str()` output of the evaluated expression |
| `completion` | `expr`, `trigger` (`$` or `@`) | Array of `{name, type, str}`, where `str` is the element's class |
| `plot_latest` | `width`, `height`, `format` (`svglite` or `png`), `devArgs` | `format`, `data` (base64) |
| `dataview_init` | `view_id` | `columns`, `totalRows` |
| `dataview_page` | `view_id`, `startRow`, `endRow`, `sortModel`, `filterModel` | `rows`, `totalRows`, `totalUnfiltered`, `lastRow` |
| `dataview_dispose` | `view_id` | `true` |

Example exchange:

```json
{"jsonrpc":"2.0","id":4,"method":"completion","params":{"expr":"mtcars","trigger":"$"}}
{"jsonrpc":"2.0","id":4,"result":[{"name":"mpg","type":"double","str":"numeric"},{"name":"cyl","type":"double","str":"numeric"}]}
```
