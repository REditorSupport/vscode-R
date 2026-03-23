# `sess`: Modern R IPC Server Protocol

The `sess` package provides a high-performance IPC (Inter-Process Communication) mechanism between R and a client (such as an IDE or editor extension). It uses a pure **WebSocket over Unix Domain Sockets / Named Pipes** architecture to replace legacy file-based watchers. By leveraging OS-level sockets, it inherently provides secure access control without the need for token authentication.

## 1. Connection Handshake

### Starting the Server

The server can be started by calling `sess::sess_app()`:

```r
sess::sess_app(
  pipe_path = NULL,      # String: Path to the pipe/socket (temp file if NULL)
  use_rstudioapi = TRUE, # Logical: Enable RStudio API emulation
  use_httpgd = TRUE      # Logical: Use httpgd for plotting if available
)
```

It prints a connection string to the R console:

```text
[sess] Server pipe: /tmp/sess-pipe-xyz
```

## 2. Communication Channels

`sess` uses a pure WebSocket architecture following the **JSON-RPC 2.0** specification for all structured data exchange. The WebSocket connection serves three main purposes: pushing instantaneous events from R to the client via notifications, allowing R to synchronously call client-side methods, and allowing the client to query R state via asynchronous requests.

### 1. Client Notifications (`notify_client`)

The WebSocket is used for instantaneous events pushed from R to the client as **JSON-RPC Notifications** (no `id`).

**Notification Format:**

```json
{
  "jsonrpc": "2.0",
  "method": "method_name",
  "params": { ... }
}
```

The following methods are sent as notifications from R to the client:

- **`attach`**: Sent immediately upon connection. Includes PID, R version, and session metadata.
- **`detach`**: Sent when the R session is shutting down (params: `pid`).
- **`dataview`**: Triggered by `View()`. Params include a temporary JSON file path containing the data.
- **`plot_updated`**: Notifies that a new static plot is available. The client should request the `plot_latest` method.
- **`httpgd`**: Provides a URL for an `httpgd` live plot server (params: `url`).
- **`help`**: Requests the client to display an R help page (params: `requestPath`).
- **`browser`**: Requests the client to open a URL (params: `url`, `title`, `viewer`).
- **`webview`**: Requests the client to open a local HTML file or URL in a webview (params: `file`, `title`, `viewer`).
- **`restart_r`**: Requests the client to restart the R session (params: `command`, `clean`).
- **`send_to_console`**: Sends code to the console for execution without blocking the R session (params: `code`, `execute`, `focus`, `animate`).

### 2. Synchronous Client Requests (`request_client`)

The `request_client()` function allows R to call client-side functions synchronously by sending a **JSON-RPC Request** (with an `id`) over the WebSocket. This is primarily used to emulate the RStudio API.

**Coordinate Handling**: The `sess` protocol uses **1-indexed** coordinates for all rows (lines) and columns (characters) on the wire. This aligns with R's internal representation. The client (e.g., VS Code extension) is responsible for converting these to its internal 0-indexed representation if necessary.

**Serialization Format**:

- **Position**: A numeric array `[row, column]`.
- **Range**: An object `{ "start": [row, column], "end": [row, column] }`.

Below are the JSON-RPC methods sent from R to the client to emulate RStudio API functionality:

- **`rstudioapi/active_editor_context`**: Requests the current context of the active editor.
- **`rstudioapi/replace_text_in_current_selection`**: Replaces text in the current selection (params: `text`, `id`).
- **`rstudioapi/insert_or_modify_text`**: Inserts or modifies text at specific locations (params: `query`, `id`).
- **`rstudioapi/show_dialog`**: Displays a message dialog to the user (params: `message`).
- **`rstudioapi/navigate_to_file`**: Opens and navigates to a specific file, line, and column (params: `file`, `line`, `column`).
- **`rstudioapi/set_selection_ranges`**: Sets the cursor or selection ranges in the editor (params: `ranges`, `id`).
- **`rstudioapi/document_save`**: Saves the specified document (params: `id`).
- **`rstudioapi/get_project_path`**: Retrieves the current project path.
- **`rstudioapi/document_context`**: Retrieves the context of a specific document (params: `id`).
- **`rstudioapi/document_save_all`**: Saves all open documents.
- **`rstudioapi/document_new`**: Creates a new document with specified text and type (params: `text`, `type`, `position`).
- **`rstudioapi/document_close`**: Closes the specified document (params: `id`, `save`).

### 3. Server Requests (Pull API)

The Pull API allows the client to query state using **JSON-RPC Requests** sent over the active WebSocket.

#### JSON-RPC Request Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "method_name",
  "params": { ... }
}
```

#### Available Methods

**`workspace`**
Returns object metadata from the Global Environment.

- **Request Params**: None.
- **Response Result**:

  ```json
  {
    "globalenv": {
      "my_df": { "class": "data.frame", "type": "list", "length": 5, "str": "data.frame: 32 obs. of 11 variables:" }
    },
    "search": ["package:stats", "package:graphics"],
    "loaded_namespaces": ["sess", "httpuv"]
  }
  ```

**`plot_latest`**
Returns the most recent static plot captured by the R session.

- **Request Params**: None.
- **Response Result**: `{"data": "iVBORw0KGgoAAAANSUhEUgA..."}` (base64 encoded PNG string). Returns `{"data": null}` if no plot exists.

**`hover`**

- **Request Params**: `{"expr": "head(mtcars)"}`
- **Response Result**: `{"str": " 'data.frame': 6 obs. of 11 variables: ..."}`

**`completion`**

- **Request Params**: `{"expr": "mtcars", "trigger": "$"}`
- **Response Result**:

  ```json
  [
    { "name": "mpg", "type": "double", "str": "numeric" },
    { "name": "cyl", "type": "double", "str": "numeric" }
  ]
  ```

---

## 3. Hook Registration & Options

By default, the package does not inject hooks into the R session on load. Calling `sess::sess_app()` will start the server and automatically call `sess::register_hooks()` to enable features like automatic `View()` interception or plot redirection.

### Intercepted Functions

- **`utils::View()`**: Redirects data to the client's data viewer. Supports `data.frame`, `matrix`, `list`, and `ArrowTabular` objects.
- **`browser()`**, **`viewer()`**, **`page_viewer()`**: Redirects URLs and HTML files to the client's browser or webview.
- **Help System**: Intercepts help topic printing to route HTML help to the client.

### Global Options

- **`sess.row_limit`**: Limits the number of rows sent to the data viewer (default: 100). Set to 0 for no limit.
- **`sess.dataview`**: Target viewer column for data (default: `"Two"`).
- **`sess.browser`**: Target viewer for browser (default: `"Active"`).
- **`sess.webview`**: Target viewer for webview (default: `"Two"`).
- **`sess.helpPanel`**: Target viewer for help (default: `"Two"`).

## 4. Comparison with Legacy IPC

The `sess` package replaces the legacy file-based IPC mechanism with a modern, in-memory WebSocket architecture using **JSON-RPC 2.0**.

| Feature | Legacy IPC (File-based) | Modern IPC (`sess`) |
| :--- | :--- | :--- |
| **Command Dispatch** | `request.log` + `request.lock` | **WS Notification** (JSON-RPC) |
| **Workspace State** | `workspace.json` + `workspace.lock` | **WS Request `workspace`** (On-demand) |
| **Static Plots** | `plot.png` + `plot.lock` | **WS Notification** + **WS Request `plot_latest`** |
| **RStudio API (Sync)**| `request.log` + `response.lock` | **WS Request** (JSON-RPC) |
| **Client Queries** | Internal HTTP Server (`httpuv`) | **WS Request** (JSON-RPC 2.0) |
| **Transport Reliability**| OS-level File System Watchers | **WebSocket** |
| **Protocol Standard** | Ad-hoc JSON formats | **JSON-RPC 2.0** |

### Architectural Shifts

1. **Elimination of File Watchers**: Replaces unreliable OS-level file system watchers with persistent WebSocket connections for instantaneous event pushing.
2. **On-Demand Evaluation**: Evaluations of the Global Environment are now performed only when requested by the client, reducing R's background workload.
3. **Unified Standard**: Unifies all structured communication under the **JSON-RPC 2.0** standard across a single WebSocket connection.
