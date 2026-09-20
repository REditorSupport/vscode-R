# sess — A high-performance IPC server for R

`sess` is an R package that connects running R sessions to an editor client. Our
primary target client is the
[VS Code R extension](https://github.com/REditorSupport/vscode-R), where `sess`
powers many of the extension's core features: workspace viewer, data viewer,
plot viewer, help panel, hover and completion, and RStudio API emulation.

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

`sess` is not yet on CRAN, but the development version can be installed from
GitHub:

```r
# install.packages("remotes")
remotes::install_github("REditorSupport/vscode-R/sess")

# or: pak::pak("REditorSupport/vscode-R/sess")
```

If you prefer not to install from within an R session, you can install from
the terminal instead. A sparse clone fetches only the `sess` directory
(requires git >= 2.25):

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/REditorSupport/vscode-R.git
cd vscode-R
git sparse-checkout set sess
R CMD INSTALL sess
```

## Usage

When you start an R terminal from VS Code, the extension's R profile calls
`sess::connect()` for you. To connect a session yourself:

```r
sess::connect(
  pipe_path = NULL,      # socket/pipe path; see below
  use_rstudioapi = TRUE, # emulate rstudioapi functions
  use_httpgd = TRUE,     # allow httpgd as the plot device
  use_jgd = FALSE        # allow jgd as the plot device
)
```

If `pipe_path` is `NULL`, `connect()` looks for it in this order:

1. The `SESS_PIPE` environment variable.
2. The `pipe` field of `~/.vscode-R/sessions/{PID}.json`, a discovery file the
   extension writes so that sessions can reattach after a window reload.

## What `sess` changes in your R session

Once connected, `sess` registers hooks (via `register_hooks()`) that redirect
R's interactive features to the client:

| R feature | Behavior |
|---|---|
| `View()` | Data frames, matrices, Arrow tables and polars data frames open in a paged, sortable, filterable data viewer. Lists open as JSON; other objects as R code. |
| `browseURL()`, `viewer`, `page_viewer` | URLs and local HTML files (e.g. htmlwidgets) open in the editor. |
| `?topic`, `help.search()` | Help pages open in the editor's help panel. |
| Graphics device | Plots appear in the editor's plot viewer (see below). |
| `rstudioapi` | Editor functions such as `getActiveDocumentContext()` and `insertText()` are emulated when `use_rstudioapi = TRUE`. |
| Top-level task callback | The client is notified after each command so it can refresh the workspace view. |

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
| `sess.helpPanel` | R option | View column for help pages (default `"Two"`). |
| `SESS_PIPE` | env var | Socket/pipe path used by `connect()`. |
| `SESS_RSTUDIOAPI` | env var | `TRUE`/`FALSE`; passed as `use_rstudioapi` by the extension's R profile. |
| `SESS_PLOT_BACKEND` | env var | `auto`, `standard`, `httpgd` or `jgd`; sets `use_httpgd`/`use_jgd` in the extension's R profile. |
| `JGD_SOCKET` | env var | Socket used by the jgd device; set by the extension. |

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

### Notifications from R to client

Sent with `notify_client()`.

| Method | Params | Sent when |
|---|---|---|
| `attach` | see above | Connection is established. |
| `workspace_updated` | none | A top-level command completes. |
| `dataview` | `title`, `source`, `type`, and `view_id` (tables) or `file` (other objects) | `View()` is called. |
| `plot_updated` | none | The standard device records a new or changed plot. |
| `httpgd` | `url` | An httpgd device is opened. |
| `help` | `requestPath`, `viewer` | A help page or help search is printed. |
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
