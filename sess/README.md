# `sess`: Modern R IPC Protocol

The `sess` package provides an IPC layer between an R session and a client (such as the VS Code R extension).

Transport:

- Unix domain sockets (macOS/Linux)
- Windows named pipes

Protocol:

- JSON-RPC 2.0 messages
- JSON Lines (JSONL, newline-delimited JSON) framing (one JSON message per line)

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

After connecting, `sess` sends an `attach` notification.

Example:

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
      "version": "R version 4.5.0 (...) ",
      "start_time": "2026-05-05 06:00:00"
    }
  }
}
```

## 2. Message Transport and Framing

Transport uses JSON Lines (JSONL, newline-delimited JSON):

- sender writes one JSON-RPC object + `\n`
- receiver buffers stream chunks and dispatches complete lines only

This preserves JSON-RPC semantics while handling stream fragmentation safely.

## 3. JSON-RPC Message Types

### Notification (one-way)

```json
{
  "jsonrpc": "2.0",
  "method": "method_name",
  "params": {}
}
```

### Request (expects response)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "method_name",
  "params": {}
}
```

### Response (success)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {}
}
```

### Response (error)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32601,
    "message": "Method not found"
  }
}
```

## 4. Notifications from R to Client

`notify_client()` sends one-way events (no `id`), including:

- `attach`
- `dataview`
- `plot_updated`
- `httpgd`
- `help`
- `browser`
- `webview`
- `restart_r`
- `send_to_console`

## 5. Requests from R to Client (`request_client`)

`request_client()` sends JSON-RPC requests and waits for matching response `id`.

Used by RStudio API emulation methods, such as:

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

Coordinate convention on the wire:

- rows/columns are 1-indexed (R-style)
- client may convert to internal 0-indexed representation

## 6. Requests from Client to R (Pull API)

Client queries R state through JSON-RPC requests.

### `workspace`

Request:

```json
{"jsonrpc":"2.0","id":1,"method":"workspace","params":{}}
```

Response (example):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "globalenv": {
      "my_df": {"class": ["data.frame"], "type": "list", "length": 11}
    },
    "search": ["package:stats", "package:graphics"],
    "loaded_namespaces": ["sess", "utils"]
  }
}
```

### `plot_latest`

Request params example:

```json
{"width":800,"height":600,"format":"svglite"}
```

Response example:

```json
{"jsonrpc":"2.0","id":2,"result":{"format":"svglite","data":"<base64 or svg payload>"}}
```

### `hover`

Request params example:

```json
{"expr":"head(mtcars)"}
```

Response example:

```json
{"jsonrpc":"2.0","id":3,"result":{"str":"'data.frame': 6 obs. ..."}}
```

### `completion`

Request params example:

```json
{"expr":"mtcars","trigger":"$"}
```

Response example:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": [
    {"name":"mpg","type":"double","str":"numeric"},
    {"name":"cyl","type":"double","str":"numeric"}
  ]
}
```

## 7. Hook Registration and Cleanup

After the IPC connection succeeds, `connect()` starts the same VS Code runtime
integration managed by `register_hooks()`. If polling or writing detects that the
transport has closed, the runtime is stopped automatically. Runtime shutdown
removes its task callbacks and restores the options, bindings, S3 method, and
plot hooks it installed when their current values have not been changed by
other code. Runtime-owned graphics devices are also closed so later plotting no
longer targets a stale VS Code connection. A plot held only by a `jgd` device
may not survive a disconnect/reload. Calling `register_hooks()` again replaces
its previous runtime installation instead of accumulating callbacks.

Intercepted features include:

- `utils::View()`
- `browser()`, `viewer()`, `page_viewer()`
- help topic rendering hooks

## 8. Discovery File

To support reloads and attach workflows, the extension writes:

- `~/.vscode-R/sessions/{PID}.json`

`sess::connect()` reads this file as fallback when direct pipe parameters are unavailable.

## 9. What Changed from the WebSocket Transport

Changed:

- transport is now UDS / named pipe
- framing is JSON Lines (JSONL) over stream sockets
- authentication token exchange is removed

Unchanged:

- JSON-RPC method names and payload shapes
- request/response correlation by `id`
- high-level feature behavior (workspace, hover, completion, plot, dataview, RStudio API emulation)
