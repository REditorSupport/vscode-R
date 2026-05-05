# `sess`: Modern R IPC Protocol

The `sess` package provides a lightweight IPC layer between an R session and a client (such as the VS Code R extension). It uses JSON-RPC 2.0 messages over:

- Unix domain sockets (macOS/Linux)
- Windows named pipes

## 1. Connection Handshake

Start the client connection from R:

```r
sess::connect(
  pipe_path = NULL,      # Character: pipe/socket path. NULL -> SESS_PIPE or session file fallback
  use_rstudioapi = TRUE, # Logical: enable rstudioapi emulation
  use_httpgd = TRUE      # Logical: use httpgd for plotting if available
)
```

If `pipe_path` is omitted, `connect()` resolves it in this order:

1. `SESS_PIPE` environment variable
2. `~/.vscode-R/sessions/{PID}.json` (`pipe` field)

After connecting, `sess` sends an `attach` notification with R version, process id, and session metadata.

## 2. Message Transport

Transport is NDJSON (newline-delimited JSON). Each line is one JSON-RPC message.

- R writes JSON-RPC payloads with a trailing `\n`
- R polls the pipe periodically and dispatches complete lines

The protocol semantics remain JSON-RPC 2.0.

### Notifications (`notify_client`)

R sends JSON-RPC notifications (without `id`) for one-way events such as:

- `attach`
- `dataview`
- `plot_updated`
- `httpgd`
- `help`
- `browser`
- `webview`
- `restart_r`
- `send_to_console`

### Requests (`request_client`)

R can synchronously call client methods (JSON-RPC request with `id`) via `request_client()`.
This is used for RStudio API emulation methods, such as:

- `rstudioapi/active_editor_context`
- `rstudioapi/replace_text_in_current_selection`
- `rstudioapi/insert_or_modify_text`
- `rstudioapi/show_dialog`
- `rstudioapi/navigate_to_file`
- `rstudioapi/set_selection_ranges`
- `rstudioapi/document_save`
- `rstudioapi/get_project_path`
- `rstudioapi/document_context`
- `rstudioapi/document_save_all`
- `rstudioapi/document_new`
- `rstudioapi/document_close`

### Client Pull Requests

The client can request state from R with JSON-RPC requests:

- `workspace`
- `plot_latest`
- `hover`
- `completion`

## 3. Hook Registration & Options

`connect()` initializes runtime hooks via `register_hooks()`.

Intercepted features include:

- `utils::View()`
- `browser()`, `viewer()`, `page_viewer()`
- help topic rendering hooks

Relevant options include:

- `sess.row_limit`
- `sess.dataview`
- `sess.browser`
- `sess.webview`
- `sess.helpPanel`

## 4. Connection Discovery

To support VS Code reloads and attach workflows, the extension writes:

- `~/.vscode-R/sessions/{PID}.json`

`sess::connect()` reads this file as a fallback when direct connection parameters are not provided.

## 5. Legacy IPC Comparison

Compared with legacy file-watcher IPC, `sess` provides:

- JSON-RPC 2.0 for structured messaging
- socket/pipe transport instead of lock-file command channels
- on-demand workspace queries
- lower background churn and fewer file watch races
