# `sess`: Modern R IPC Server Protocol

The `sess` package provides a high-performance, token-authenticated IPC (Inter-Process Communication) mechanism between R and a client (such as an IDE or editor extension). It uses a hybrid **Push (WebSocket)** and **Pull (HTTP)** architecture to replace legacy file-based watchers.

## 1. Connection Handshake

When `sess::sess_app()` is started, it prints a connection string to the R console:
```text
[sess] SESS_IPC_SERVER=ws://127.0.0.1:PORT?token=TOKEN
```
A client can intercept this string or be configured with the port and token to establish a connection.

- **Port**: Randomly assigned by `httpuv::randomPort()`.
- **Token**: A random 32-character alphanumeric string generated per session.

## 2. Communication Channels

`sess` uses a hybrid architecture following the **JSON-RPC 2.0** specification for all structured data exchange.

### WebSocket (Push API)
The WebSocket is used for instantaneous events pushed from R to the client as **JSON-RPC Notifications** (no `id`).

**Notification Format:**
```json
{
  "jsonrpc": "2.0",
  "method": "method_name",
  "params": { ... }
}
```

#### Common Methods
- **`attach`**: Sent immediately upon connection. Includes PID, R version, and session metadata.
- **`detach`**: Sent when the R session is shutting down.
- **`dataview`**: Triggered by `View()`. Params include a temporary JSON file path containing the data.
- **`plot_updated`**: Notifies that a new static plot is available. The client should request the `plot_latest` method.
- **`httpgd`**: Provides a URL for an `httpgd` live plot server.
- **`help`**: Requests the client to display an R help page.
- **`browser` / `webview`**: Requests the client to open a URL or local HTML file.

---

### HTTP (Pull API)
The Pull API allows the client to query state using **JSON-RPC Requests** sent via `POST` to the `/rpc` endpoint. All HTTP requests must include the `Authorization` header set to the session token.

#### Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/rpc` | `POST` | The primary JSON-RPC 2.0 entry point. Requires `Authorization: <token>` header. |

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

3. Synchronous RStudio API Emulation

The `request_rstudioapi()` function allows R to call client-side functions synchronously by sending a **JSON-RPC Request** (with an `id`) over the WebSocket:

1. R sends a request with `method` set to the action name (e.g., `"active_editor_context"`).
2. R enters a `while` loop that calls `httpuv::service()`.
3. The client processes the action and sends back a **JSON-RPC Response** (with the same id) via the WebSocket.
4. R retrieves the `result` (or `error`) and returns it.

**Coordinate Handling**: The emulation layer automatically converts between R (1-indexed) and IPC (0-indexed) coordinates. Locations and ranges sent to the client are 0-indexed, while data received from the client (e.g., in `document_context`) is converted back to 1-indexed R objects.

## 4. Hook Registration

By default, the package does not inject hooks into the R session on load. Calling `sess::sess_app()` will start the server and automatically call `sess::register_hooks()` to enable features like automatic `View()` interception or plot redirection.

If you need to manually register hooks without starting the full app environment (or re-register them if they were overridden), you can call:
```r
sess::register_hooks()
```
This rebinds internal functions (like `utils::View`) and sets `options()` for browsers, viewers, and devices to route through the IPC server.

## 5. Comparison with Legacy IPC

The `sess` package replaces the legacy file-based IPC mechanism with a modern, in-memory hybrid architecture using **JSON-RPC 2.0**.

| Feature | Legacy IPC (File-based) | Modern IPC (`sess`) |
| :--- | :--- | :--- |
| **Command Dispatch** | `request.log` + `request.lock` | **WS Notification** (JSON-RPC) |
| **Workspace State** | `workspace.json` + `workspace.lock` | **HTTP RPC `workspace`** (On-demand) |
| **Static Plots** | `plot.png` + `plot.lock` | **WS Notification** + **HTTP RPC `plot_latest`** |
| **Client Queries** | Custom HTTP Server payload | **HTTP RPC** (JSON-RPC 2.0) |
| **Transport Reliability**| OS-level File System Watchers | **WebSocket & HTTP streams** |
| **Protocol Standard** | Ad-hoc JSON formats | **JSON-RPC 2.0** |

### Detailed Mapping: Legacy to Modern

**1. Command Dispatch (e.g., `View()`, `browser()`, `help()`)**
- **Old Approach:** R intercepted commands and appended custom JSON structures to a `request.log` file, then updated the timestamp on a `request.lock` file. The client OS file watcher detected the `.lock` file change, read the `.log` file, and processed the pending commands.
- **New Approach (`sess`):** R directly pushes an instantaneous **JSON-RPC Notification** (e.g., `method: "dataview"`, `method: "help"`) over the persistent WebSocket connection. The client receives and processes the payload instantly, bypassing disk I/O and file system watchers entirely.

**2. Workspace State (Global Environment)**
- **Old Approach:** An R task callback ran after every top-level console execution, eagerly evaluating and serializing the entire Global Environment to a `workspace.json` file, followed by touching a `workspace.lock` file. The client watched for the lock file change to read the JSON file. This caused constant overhead and disk writes, even when the client's workspace pane was hidden.
- **New Approach (`sess`):** Adopts a "Pull" architecture. The workspace is *only* evaluated and serialized when the client explicitly sends an **HTTP POST Request** to `/rpc` with `method: "workspace"`. This happens on-demand (e.g., when the UI pane is visible), saving significant R processing time and disk I/O.

**3. Static Plots**
- **Old Approach:** Plotting commands (via custom devices or hooks) generated a `plot.png` file on disk and updated a `plot.lock` file. The client watcher noticed the lock change, read the new PNG file from disk, and displayed it.
- **New Approach (`sess`):** When a new plot is generated to a temporary file, R sends a lightweight **JSON-RPC Notification** (`method: "plot_updated"`) via the WebSocket. The client then pulls the actual image data by sending an **HTTP POST Request** to `/rpc` (`method: "plot_latest"`), which returns the base64-encoded image over the network stream.

**4. Client Queries (Hover, Completion)**
- **Old Approach:** The legacy architecture sometimes ran a rudimentary local HTTP server inside R that accepted custom HTTP GET/POST queries with ad-hoc URL paths (`/hover`, `/completion`) and custom JSON body structures.
- **New Approach (`sess`):** Unified under the **JSON-RPC 2.0** standard. The client sends structured requests with strict `id` and `params` formatting to the single `/rpc` HTTP endpoint, receiving standardized JSON-RPC responses.

### Architectural Shifts

1. **Elimination of File Watchers**: The legacy system relied heavily on OS-level file system watchers (`fs.watch`) monitoring lock files to trigger client updates. This approach could be unreliable or slow across different platforms, network drives, and remote container environments. `sess` replaces this entirely with persistent WebSocket connections for instantaneous, reliable event pushing.
2. **On-Demand vs. Eager Evaluation**: Previously, R would eagerly evaluate and serialize the entire Global Environment to `workspace.json` frequently (e.g., via task callbacks), incurring significant continuous disk I/O and processing overhead. `sess` shifts this to a "Pull" model. The client requests the workspace state only when needed, significantly reducing R's background workload.
3. **Unified Standard**: Instead of maintaining separate, disparate mechanisms for command logs, JSON dumps, and custom HTTP query payloads, `sess` unifies all structured communication under the ubiquitous **JSON-RPC 2.0** standard.

### Responsiveness and the Event Loop

Because R is fundamentally single-threaded, both IPC mechanisms are constrained by the R event loop, but they surface this limitation differently to the client:

- **The "Busy" State**: If R is executing a long-running computation, the `httpuv` server running inside the session cannot process incoming HTTP requests (such as a request for `/rpc` `workspace` or `completion`). 
- **Active vs. Passive Waiting**: In the legacy system, the client passively waited for `workspace.lock` to change, effectively ignoring the busy state until the operation completed. With the `sess` HTTP RPC model, the client actively requests data. Therefore, the client *must* implement short, aggressive timeouts (e.g., 500ms) for these HTTP requests. If a timeout occurs, the client gracefully interprets this as "R is busy" and can display a loading state without locking up the IDE's UI thread.
