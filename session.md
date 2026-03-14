# R and VS Code Inter-Process Communication (IPC)

The communication between the R session and VS Code involves two primary mechanisms:

1. **R to VS Code (Asynchronous)**: File-based IPC mechanisms used to push data or trigger UI actions in VS Code. It uses specific pairs of data/log and lock files:
   - **Command Dispatch:** `request.log` and `request.lock`
   - **Workspace State:** `workspace.json` and `workspace.lock`
   - **Static Plots:** `plot.png` and `plot.lock`
2. **VS Code to R (Synchronous)**: HTTP Server IPC where R runs a local `httpuv` server that VS Code queries.

Here are the relevant code snippets for each mechanism.

---

## 1. R to VS Code (File-based IPC)

When R wants to push data or trigger UI actions in VS Code, it writes a payload or image to a temporary file and updates a corresponding lock file to notify VS Code's file system watcher.

### 1.1 Command Dispatch (`request.log`)

The base function used to send requests from R is `request()`. It writes the command and arguments to `request_file` and updates `request_lock_file` with a timestamp.

#### R Component ([`R/session/vsc.R`](R/session/vsc.R))

```r
get_timestamp <- function() {
    sprintf("%.6f", Sys.time())
}

request <- function(command, ...) {
    obj <- list(
        time = Sys.time(),
        pid = pid,
        wd = wd,
        command = command,
        ...
    )
    jsonlite::write_json(obj, request_file,
        auto_unbox = TRUE, null = "null", force = TRUE
    )
    cat(get_timestamp(), file = request_lock_file)
}
```

R uses this core `request` function to send 8 distinct types of commands to VS Code. Below are snippets representing how each command is triggered from R:

**1. webview**: Opens a local HTML file in a VS Code Webview panel (e.g., for htmlwidgets). [-> `show_webview`](R/session/vsc.R#L729)

```r
show_webview <- function(url, title, ..., viewer) {
    if (file.exists(url)) {
        file <- normalizePath(url, "/", mustWork = TRUE)
        request("webview", file = file, title = title, viewer = viewer, ...)
    }
}
```

**2. browser**: Opens an external URL or help page via VS Code. [-> `request_browser`](R/session/vsc.R#L675)

```r
request_browser <- function(url, title, ..., viewer) {
    request("browser", url = url, title = title, ..., viewer = viewer)
}
```

**3. dataview**: Opens the built-in VS Code data viewer (triggered by `View()`).

```r
# Inside dataview handler for a table/dataframe
file <- tempfile(tmpdir = tempdir, fileext = ".json")
jsonlite::write_json(data, file, na = "string", null = "null", auto_unbox = TRUE, force = TRUE)
request("dataview", source = "table", type = "json",
    title = title, file = file, viewer = viewer, uuid = uuid
)
```

**4. httpgd**: Notifies VS Code that an `httpgd` plot graphics device is ready.

```r
.vsc$request("httpgd", url = httpgd::hgd_url())
```

**5. attach**: Called when the R session starts and attaches to VS Code, providing session metadata and the `SessionServer` credentials. [-> `attach`](R/session/vsc.R#L639)

```r
attach <- function() {
    request("attach",
        version = sprintf("%s.%s", R.version$major, R.version$minor),
        tempdir = tempdir,
        info = list(...)
    )
}
```

**6. detach**: Called when the R session is closing to clean up resources.

```r
reg.finalizer(.GlobalEnv, function(e) .vsc$request("detach"), onexit = TRUE)
```

**7. help**: Opens the help documentation panel inside VS Code.

```r
request(command = "help", requestPath = requestPath, viewer = viewer)
```

**8. rstudioapi**: Emulates an `rstudioapi` request synchronously. It waits for VS Code to respond using a `response.lock` polling mechanism.

```r
request_response <- function(command, ...) {
    request(command, ..., sd = dir_session)
    wait_start <- Sys.time()
    while (!get_response_lock()) {
        # Loop and sleep waiting for VS Code to reply
    }
}
# (Dispatches to request_response with command = "rstudioapi")
```

#### TypeScript Component ([`src/session.ts`](src/session.ts))

VS Code uses `fs.watch` to monitor the `request.lock` file. When modified, it reads `request.log` and dispatches the command.

```typescript
export function startRequestWatcher(sessionStatusBarItem: StatusBarItem): void {
    requestFile = path.join(homeExtDir(), 'request.log');
    requestLockFile = path.join(homeExtDir(), 'request.lock');
    requestTimeStamp = 0;
    
    // Watch the lock file for changes
    fs.watch(requestLockFile, {}, () => {
        void updateRequest(sessionStatusBarItem);
    });
}
```

Inside `updateRequest`, the JSON payload is parsed and the specific `command` is passed to its respective handler function. Here is a detailed breakdown of how each command is resolved in VS Code:

**1. `webview` Handler**

```typescript
case 'webview': {
    if (request.file && request.title && request.viewer !== undefined) {
        await showWebView(request.file, request.title, request.viewer);
    }
    break;
}
```

**Detail (`showWebView` [-> src/session.ts#L313](src/session.ts#L313)):**
This handles local HTML content, most notably interactive `htmlwidgets`.

```typescript
export async function showWebView(file: string, title: string, viewer: string | boolean): Promise<void> {
    if (viewer === false) {
        void env.openExternal(Uri.file(file));
    } else {
        const dir = path.dirname(file);
        const webviewDir = extensionContext.asAbsolutePath('html/session/webview/');
        const panel = window.createWebviewPanel('webview', title,
            { preserveFocus: true, viewColumn: ViewColumn[String(viewer) as keyof typeof ViewColumn] },
            {
                enableScripts: true, enableFindWidget: true, retainContextWhenHidden: true,
                localResourceRoots: [Uri.file(dir), Uri.file(webviewDir)],
            });
        panel.iconPath = new UriIcon('globe');
        panel.webview.html = await getWebviewHtml(panel.webview, file, title, dir, webviewDir);
    }
}
```

1. **Fallback to OS Browser**: If `viewer` is explicitly `false`, it bypasses VS Code and opens the file in the OS's default external browser via `env.openExternal(Uri.file(file))`.
2. **Creating the Panel**: Otherwise, `showWebView()` uses the VS Code API `window.createWebviewPanel()` to instantiate a native panel.
3. **Security and Access**: It explicitly restricts file system access by setting `localResourceRoots`. It only allows the webview to read assets from two places: the directory containing the HTML file itself (so local CSS/JS dependencies can load), and the extension's `html/session/webview/` directory.
4. **HTML Injection**: It calls `getWebviewHtml()` ([-> src/session.ts#L651](src/session.ts#L651)), which reads the target HTML file into a string. Crucially, it uses a regular expression to rewrite all relative `href` and `src` paths into secure `vscode-webview-resource://` URIs by prepending `webview.asWebviewUri(Uri.file(dir))`. Finally, it wraps the content with a Content Security Policy (CSP) and injects a custom `observer.js` script to handle layout updates, before assigning the final string to `panel.webview.html`.

**2. `browser` Handler**

```typescript
case 'browser': {
    if (request.url && request.title && request.viewer !== undefined) {
        await showBrowser(request.url, request.title, request.viewer);
    }
    break;
}
```

**Detail (`showBrowser` [-> src/session.ts#L225](src/session.ts#L225)):**
This handles external URLs and active R servers (like the R help server).

```typescript
export async function showBrowser(url: string, title: string, viewer: string | boolean): Promise<void> {
    const uri = Uri.parse(url);
    if (viewer === false) {
        void env.openExternal(uri);
    } else {
        const externalUri = await env.asExternalUri(uri);
        const panel = window.createWebviewPanel('browser', title,
            { preserveFocus: true, viewColumn: ViewColumn[String(viewer) as keyof typeof ViewColumn] },
            { enableFindWidget: true, enableScripts: true, retainContextWhenHidden: true });
        
        // event listeners for activeBrowserPanel omitted for brevity
        
        panel.iconPath = new UriIcon('globe');
        panel.webview.html = getBrowserHtml(externalUri); // Injects <iframe src="${uri}" width="100%" height="100%" />
    }
}
```

1. **URI Translation**: It uses `env.asExternalUri(uri)` on the requested URL. This is a critical step because if the VS Code session is running remotely (e.g., via SSH, GitHub Codespaces, or Dev Containers), this VS Code API automatically sets up an encrypted port-forwarding tunnel so the local IDE can access the remote R HTTP server securely.
2. **Creating the Panel**: Like `webview`, it creates a `WebviewPanel` titled "browser".
3. **State Management**: It attaches event listeners to track the active browser state (`activeBrowserPanel` and `activeBrowserUri`). This allows the extension to provide fallback commands like `refreshBrowser` or `openExternalBrowser` on the currently viewed page.
4. **Iframe Embedding**: Instead of reading file contents, `getBrowserHtml()` simply generates a lightweight HTML template containing a fullscreen `<iframe src="${uri}" width="100%" height="100%" />` element. This embeds the live web page directly inside the IDE panel.

**3. `dataview` Handler**

```typescript
case 'dataview': {
    if (request.source && request.type && request.file && request.title && request.viewer !== undefined) {
        await showDataView(request.source, request.type, request.title, request.file, request.viewer);
    }
    break;
}
```

**Detail (`showDataView` [-> src/session.ts#L337](src/session.ts#L337)):**
Activated by calling `View()` on an R object (like a `data.frame` or `list`).

```typescript
export async function showDataView(source: string, type: string, title: string, file: string, viewer: string): Promise<void> {
    if (source === 'table') {
        const panel = window.createWebviewPanel('dataview', title,
            { preserveFocus: true, viewColumn: ViewColumn[viewer as keyof typeof ViewColumn] },
            { enableScripts: true, enableFindWidget: true, retainContextWhenHidden: true, localResourceRoots: [Uri.file(resDir)] });
        panel.iconPath = new UriIcon('open-preview');
        panel.webview.html = await getTableHtml(panel.webview, file, title);
    } else if (source === 'list') {
        // similar to table, but calls getListHtml(panel.webview, file, title)
    } else {
        // Fallback for raw text 'object'
        await commands.executeCommand('vscode.open', Uri.file(file), {
            preserveFocus: true, preview: true, viewColumn: ViewColumn[viewer as keyof typeof ViewColumn],
        });
    }
}
```

1. **Data Source - Table**: If the source is `'table'`, `showDataView()` creates a webview panel and gives it access to the extension's `dist/resources` folder. It reads the temporary `.json` data file dumped by R and passes the raw JSON into `getTableHtml()`. This function injects the data into an HTML template bundled with `ag-grid-community`, rendering a rich, interactive, sortable, filterable, and paginated data table interface purely via JavaScript.
2. **Data Source - List**: If the source is `'list'`, it takes a similar approach but uses `getListHtml()`, rendering the data as a collapsible JSON tree view.
3. **Fallback - Virtual Document**: If the object was too complex to serialize to JSON and R fell back to an `'object'` representation text file (`txt`), it skips the Webview entirely. Instead, it reads the file and opens it natively inside the IDE as a read-only Virtual Document using `vscode.open` and a custom document provider.

**4. `httpgd` Handler**

```typescript
case 'httpgd': {
    if (request.url) {
        await globalPlotManager?.showHttpgdPlot(request.url);
    }
    break;
}
```

**Detail (`httpgd` [-> src/plotViewer/index.ts](src/plotViewer/index.ts)):**
Triggered when an R script opens an `httpgd` graphics device (a modern SVG/HTML-based plotting device for R).

1. **Intercepting the URL**: R tells VS Code the exact local URL/port where the `httpgd` server is streaming the plots.
2. **Delegation to Manager**: The session handler passes this URL to the `globalPlotManager` (an instance of `CommonPlotManager` defined in `src/plotViewer/index.ts`).
3. **Viewer Instantiation**: The manager parses the URL, extracting the host and security token. It searches to see if a viewer for that host already exists. If not, it instantiates a new `HttpgdViewer`.
4. **Webview Rendering**: The `HttpgdViewer` spins up a dedicated `WebviewPanel`. Instead of just embedding the plot as a static image, it loads a full React-based frontend application (bundled in the extension's resources) into the webview. This frontend connects directly to the R `httpgd` server via WebSockets to provide a live, interactive, resizable plot viewer with history tracking and export capabilities.

**5. `attach` Handler**

```typescript
case 'attach': {
    if (!request.tempdir || !request.wd) return;
    // Update local variables
    rVer = String(request.version);
    pid = String(request.pid);
    sessionDir = path.join(request.tempdir, 'vscode-R');

    // UI Updates
    sessionStatusBarItem.text = `R ${rVer}: ${pid}`;
    sessionStatusBarItem.show();
    await setContext('rSessionActive', true);

    if (request.server) {
        server = request.server;
    }
    void watchProcess(pid).then((v: string) => { void cleanupSession(v); });
    break;
}
```

**Detail (`attach`):**
This is the foundational bootstrapping command. When R starts and sources the VS Code initialization script, it fires this payload.

1. **State Initialization**: It caches critical session metadata into global variables: the active Process ID (`pid`), the R version (`rVer`), and the temporary session directory (`sessionDir`).
2. **Status Bar Integration**: It updates the VS Code Status Bar at the bottom of the screen (e.g., displaying "R 4.3: 12345") to give the user visual confirmation that the IDE is hooked into the R terminal.
3. **Context Switching**: It sets the VS Code context key `rSessionActive` to `true`. This enables context-aware menus, shortcuts, and features that should only be visible when R is running.
4. **Synchronous IPC Setup**: Critically, it extracts the `request.server` object (which contains the `{httpuv}` host, port, and auth token) and saves it to the exported `server` variable, fully enabling the Synchronous HTTP IPC channel.
5. **Process Monitoring**: It initiates `watchProcess(pid)` ([-> src/session.ts#L862](src/session.ts#L862)). This sets up an OS-level listener (using `process.kill(pid, 0)` checks or equivalent) to continuously monitor if the R process is alive. If the terminal is killed or R crashes, the watcher resolves, immediately triggering `cleanupSession()`.

**6. `detach` Handler**

```typescript
case 'detach': {
    if (request.pid) {
        await cleanupSession(request.pid);
    }
    break;
}
```

**Detail (`detach` / `cleanupSession` [-> src/session.ts#L845](src/session.ts#L845)):**
Triggered explicitly by R's `.GlobalEnv` finalizer when the session is closing cleanly, or triggered forcefully by the `watchProcess` monitor if R crashes.

1. **State Verification**: `cleanupSession(pidArg)` first checks if the `pid` trying to detach matches the currently tracked `pid`. This prevents race conditions if multiple R terminals are open.
2. **UI Teardown**: It resets the status bar text to "R: (not attached)".
3. **Data Clearing**: It aggressively clears the cached data. It sets `server = undefined` (cutting off HTTP IPC), empties the `workspaceData` (global environment variables, loaded namespaces), and commands the UI Workspace Viewer to refresh (effectively blanking out the variable explorer).
4. **Addin Purging**: It calls `purgeAddinPickerItems()`, clearing out any cached RStudio Addins that were registered by that specific R session.

**7. `help` Handler**

```typescript
case 'help': {
    if (globalRHelp && request.requestPath) {
        await globalRHelp.showHelpForPath(request.requestPath, request.viewer);
    }
    break;
}
```

**Detail (`help` [-> src/helpViewer/index.ts#L587](src/helpViewer/index.ts#L587)):**
Activated when you use `?function` or `help()` in R.

1. **Delegation**: It passes the specific help path to the `globalRHelp` provider (an instance of `RHelp` from `src/helpViewer/index.ts`).
2. **Internal Server Hook**: VS Code doesn't just open a dumb browser. R's internal dynamic help server (which handles parsing `.Rd` files to HTML) is running in the background. The `globalRHelp` manager constructs the correct URL targeting R's internal help port.
3. **Custom Webview**: It opens a custom `HelpPanel` webview. This webview does not just display the HTML; it intercepts internal link clicks. If you click a link to another package's documentation, the webview intercepts the navigation event, prevents a full page reload, and requests the new content via the VS Code IPC, resulting in a much faster, app-like navigation experience for R help files.

**8. `rstudioapi` Handler**

```typescript
case 'rstudioapi': {
    if (request.action && request.args && request.sd) {
        await dispatchRStudioAPICall(request.action, request.args, request.sd);
    }
    break;
}
```

**Detail (`rstudioapi` [-> src/rstudioapi.ts#L22](src/rstudioapi.ts#L22)):**
This is a complex bridge that allows R scripts (or packages that depend on `{rstudioapi}`) to natively control the VS Code editor, mimicking RStudio IDE behaviors.

1. **Synchronous Blocking in R**: When R calls an `rstudioapi` function, the R process writes the request to `request.log` and then enters an infinite `while` loop, aggressively polling for the existence of a `response.log` file. R is completely blocked at this point.
2. **Action Dispatching**: VS Code receives the request and passes it to `dispatchRStudioAPICall()` (in `src/rstudioapi.ts`). This function contains a large `switch` statement handling RStudio API actions like:
    - `active_editor_context`: Gets the currently selected text and cursor position using VS Code's `window.activeTextEditor`.
    - `insert_or_modify_text`: Applies a `WorkspaceEdit` using the VS Code API to programmatically type code into the editor.
    - `navigate_to_file`: Uses `vscode.open` to jump the user's cursor to a specific file and line.
3. **Unblocking R**: Once the VS Code API task completes, the handler MUST resolve the blocking loop. It does this by calling `writeResponse(data, sd)` or `writeSuccessResponse(sd)`. This function writes the requested data (or a simple boolean `true`) into a `response.log` file located in the session directory, and creates a `response.lock` file.
4. **Resumption**: R's polling loop detects the lock file, reads the response data, breaks the loop, and returns the data back to the original `{rstudioapi}` function call.

### 1.2 Workspace State (`workspace.json`)

To populate the VS Code Workspace Viewer (Variable Explorer), R continuously monitors the `.GlobalEnv` and serializes its structure whenever it changes.

#### R Component

R maintains an `update_workspace` function that compares the current `.GlobalEnv` against a cached `globalenv_cache`. It calls `inspect_env` to extract metadata (type, class, size, dimensions, and a string preview using `capture_str()`) for all variables. This structured list is serialized via `jsonlite::write_json()` to `workspace.json`, and `workspace.lock` is updated with a timestamp.

```r
update_workspace <- function(...) {
    tryCatch({
        data <- list(
            globalenv = if (show_globalenv) inspect_env(.GlobalEnv, globalenv_cache) else NULL
        )
        jsonlite::write_json(data, workspace_file, force = TRUE, pretty = FALSE)
        cat(get_timestamp(), file = workspace_lock_file)
    }, error = message)
    TRUE
}
```

#### TypeScript Component

VS Code watches `workspace.lock` inside `updateSessionWatcher()`. When it detects a change, it reads the newly updated `workspace.json`, parses it into the global `workspaceData` object, and triggers a refresh event on the `workspaceViewer`. The tree view in VS Code then natively renders the updated variables and their properties.

```typescript
async function updateWorkspace() {
    const lockContent = await fs.readFile(workspaceLockFile, 'utf8');
    const newTimeStamp = Number.parseFloat(lockContent);
    if (newTimeStamp !== workspaceTimeStamp) {
        workspaceTimeStamp = newTimeStamp;
        if (fs.existsSync(workspaceFile)) {
            const content = await fs.readFile(workspaceFile, 'utf8');
            workspaceData = JSON.parse(content) as WorkspaceData;
            void rWorkspace?.refresh(); // Refreshes the Workspace Viewer Tree
        }
    }
}
```

### 1.3 Static Plotting (`plot.png`)

For users not using the modern `httpgd` device, R can be configured to produce static plots that are automatically displayed in VS Code.

#### R Component

R configures a custom `options(device = ...)` that initializes a null PDF device (to capture drawing operations silently). It overrides graphics hooks (`setHook("plot.new", ...)` and `rebind(".External.graphics", ...)`). When a plot is fully drawn, the `update_plot` function renders it using `png()` to a temporary `plot.png` file, then updates `plot.lock` with a timestamp.

```r
update_plot <- function(...) {
    if (plot_updated && check_null_dev()) {
        plot_updated <<- FALSE
        record <- recordPlot()
        if (length(record[[1L]])) {
            dev_args <- getOption("vsc.dev.args")
            do.call(png, c(list(filename = plot_file), dev_args))
            on.exit({
                dev.off()
                cat(get_timestamp(), file = plot_lock_file)
            })
            replayPlot(record)
        }
    }
    TRUE
}
```

#### TypeScript Component

Similar to the workspace watcher, VS Code monitors `plot.lock`. When modified, it uses the VS Code native API `vscode.open` to display the updated `plot.png` file in a built-in image viewer panel.

```typescript
async function updatePlot() {
    const lockContent = await fs.readFile(plotLockFile, 'utf8');
    const newTimeStamp = Number.parseFloat(lockContent);
    if (newTimeStamp !== plotTimeStamp) {
        plotTimeStamp = newTimeStamp;
        if (fs.existsSync(plotFile) && fs.statSync(plotFile).size > 0) {
            void commands.executeCommand('vscode.open', Uri.file(plotFile), {
                preserveFocus: true,
                preview: true,
                viewColumn: ViewColumn[(config().get<string>('session.viewers.viewColumn.plot') || 'Two') as keyof typeof ViewColumn],
            });
        }
    }
}
```

---

## 2. VS Code to R (Synchronous HTTP IPC)

For synchronous querying (e.g., fetching hover information, workspace variables, or autocomplete suggestions), the file-based IPC is too slow and chaotic. Instead, VS Code acts as an HTTP client sending POST requests directly to an internal HTTP server hosted by the R process.

### R Component (`R/session/vsc.R`)

Upon attaching to the VS Code terminal, R initializes a background HTTP server using the `{httpuv}` package.

1. **Security and Bootstrapping**: It generates a secure, randomized `token` and binds to a `randomPort()` on `127.0.0.1`. It passes these credentials back to VS Code via the initial file-based `"attach"` request.
2. **Request Routing**: The `httpuv` server listens for HTTP POST requests. When a request arrives, it validates the `HTTP_AUTHORIZATION` header against its secret token.
3. **JSON Payload parsing**: It parses the body of the request (which is sent as JSON from VS Code) to figure out the `type` of request.
4. **Request Handlers**: It routes the execution to specific functions defined in `request_handlers`.
    - `hover`: Evaluates an expression (like a variable name the user is hovering over) in the `.GlobalEnv` and uses `capture_str()` to return a formatted string representation of the object's structure.
    - `complete`: Handles autocompletion logic. For example, if the user types `df$`, the server intercepts the `$` trigger, evaluates `df`, and uses `.DollarNames` to return a list of all column names and their data types back to VS Code.

```r
        # Bootstrapping the Session Server
        host <- "127.0.0.1"
        port <- httpuv::randomPort()
        token <- sprintf("%d:%d:%.6f", pid, port, Sys.time())
        
        request_handlers <- list(
            hover = function(expr, ...) {
                tryCatch({
                    expr <- parse(text = expr, keep.source = FALSE)[[1]]
                    obj <- eval(expr, .GlobalEnv)
                    list(str = capture_str(obj))
                }, error = function(e) NULL)
            },
            complete = function(expr, trigger, ...) {
                # Logic to handle '$' or '@' triggers and return available names/slots
                # ...
            }
        )

        server <- httpuv::startServer(host, port,
            list(
                onHeaders = function(req) {
                    # Validate auth token
                    if (!identical(req[["HTTP_AUTHORIZATION"]], token)) {
                        return(list(status = 401L, headers = list("Content-Type" = "text/plain"), body = "Unauthorized"))
                    }
                    # ...
                },
                call = function(req) {
                    content <- req$rook.input$read_lines()
                    request <- jsonlite::fromJSON(content, simplifyVector = FALSE)
                    
                    # Route to internal request handlers based on type (e.g., 'hover', 'complete')
                    handler <- request_handlers[[request$type]]
                    response <- if (is.function(handler)) do.call(handler, request)

                    list(
                        status = 200L,
                        headers = list("Content-Type" = "application/json"),
                        body = jsonlite::toJSON(response, auto_unbox = TRUE, force = TRUE)
                    )
                }
            )
        )
        attr(server, "token") <- token
        options(vsc.server = server)
```

### TypeScript Component (`src/session.ts` and `src/completions.ts`)

Once VS Code receives the `"attach"` payload from R, it globally caches the `SessionServer` details. It then exposes a `sessionRequest` helper function for various UI Language Providers.

**The `sessionRequest` Function (`src/session.ts`)**:
This is a wrapper around `node-fetch`. It sends an HTTP POST request to `http://${server.host}:${server.port}`, stringifies the requested data into the JSON body, and critically, attaches the `server.token` to the `Authorization` header. It then awaits the JSON response.

```typescript
export interface SessionServer {
    host: string;
    port: number;
    token: string;
}

export let server: SessionServer | undefined;

// Function called by language features (hover, completion, etc.)
export async function sessionRequest(server: SessionServer, data: any): Promise<any> {
    try {
        const response = await fetch(`http://${server.host}:${server.port}`, {
            agent: httpAgent, // Keep-alive agent
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: server.token
            },
            body: JSON.stringify(data),
            follow: 0,
            timeout: 500, // Very short timeout for snappiness
        });

        if (!response.ok) throw new Error(`Error! status: ${response.status}`);
        return response.json();
    } catch (error) {
        console.log('error: ', error);
    }
}
```

**Implementation in Language Providers (`src/completions.ts`)**:
When a user interacts with the editor (like hovering over a word or typing `$` to trigger completions), VS Code's extension API fires its respective provider events. These providers intercept the event, parse the text, and use `sessionRequest()` to ask the R HTTP server for live execution context.

**1. Hover Provider (`type: 'hover'`):** [-> src/completions.ts#L34](src/completions.ts#L34)
When you hover your mouse over a variable (e.g., `my_data`) in the editor:

- **VS Code (Request)**: The `HoverProvider` in `src/completions.ts` uses a regex to grab the word under the cursor. It sends a JSON payload to the HTTP server: `{ "type": "hover", "expr": "my_data" }`.
- **R (Processing)**: The `hover` handler inside `vsc.R`'s `request_handlers` takes over. It uses `parse(text = expr)` to turn the string into an R expression, and `eval(expr, .GlobalEnv)` to safely evaluate it in the global workspace. It then passes the resulting object into a custom `capture_str()` function (a wrapper around R's native `str()` function) to generate a concise, human-readable structural summary of the object.
- **R (Response)**: It returns `{ "str": "data.frame': 3 obs. of  2 variables:\n $ x: num 1 2 3\n $ y: chr 'a' 'b' 'c'" }`.
- **VS Code (Rendering)**: The Hover Provider receives this JSON, extracts the `.str` property, and wraps it in a `vscode.MarkdownString` formatted as an R code block (` ```r `). This is what pops up in the IDE as the hover tooltip.

```typescript
export class HoverProvider implements vscode.HoverProvider {
    async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | null> {
        // ... (Environment and Rmd checks omitted) ...

        let hoverRange = document.getWordRangeAtPosition(position);
        let hoverText = null;

        if (session.server) {
            const exprRegex = /([a-zA-Z0-9._$@ ])+(?<![@$])/;
            hoverRange = document.getWordRangeAtPosition(position, exprRegex)?.with({ end: hoverRange?.end });
            const expr = document.getText(hoverRange);
            const response = await session.sessionRequest(session.server, {
                type: 'hover',
                expr: expr
            });

            if (response) {
                hoverText = response.str;
            }
        } // ...

        if (hoverText) {
            return new vscode.Hover(`\`\`\`\n${hoverText}\n\`\`\``, hoverRange);
        }
        return null;
    }
}
```

**2. Completion Provider (`type: 'complete'`):** [-> src/completions.ts#L133](src/completions.ts#L133)
When you type a trigger character like `$` (for lists/dataframes) or `@` (for S4 objects), you expect to see the internal properties of that object.

- **VS Code (Request)**: If you type `df$`, the `CompletionItemProvider` grabs the `df` preceding the cursor and sends: `{ "type": "complete", "expr": "df", "trigger": "$" }`.
- **R (Processing)**: The `complete` handler in `vsc.R` evaluates `df`. If it evaluates successfully, it checks the `trigger`:
  - If `trigger == "$"`, it uses R's internal `.DollarNames(obj)` (for objects) or `names(obj)` (for recursive lists) to get an array of available property names.
  - If `trigger == "@"`, it uses `slotNames(obj)` to get the S4 slot names.
  - It then loops over those names. For each property (e.g., a specific column in a dataframe), it determines its `typeof()` and uses `try_capture_str()` to get a preview of its contents.
- **R (Response)**: It returns a JSON array of `RObjectElement` items: `[ { "name": "col_A", "type": "double", "str": "num [1:10] 1.5 2.1..." }, ... ]`.
- **VS Code (Rendering)**: The Completion Provider receives this array and passes it to `getCompletionItemsFromElements()` ([-> src/completions.ts#L221](src/completions.ts#L221)). This helper function loops over the R items and converts them into native VS Code `vscode.CompletionItem` objects.
  - `e.name` becomes the label shown in the dropdown list.
  - `e.type` determines the icon (e.g., if it's a "closure" or "builtin", it gets a Function icon $f(x)$, otherwise it gets a Variable/Field icon).
  - `e.str` is wrapped in a Markdown code block and attached to `item.documentation`, so when you highlight a column name in the dropdown, a side-panel shows you a preview of the data inside that column.
  - Finally, the provider returns these items, and VS Code renders the native Intellisense UI.

```typescript
export class LiveCompletionItemProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        completionContext: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[]> {
        const items: vscode.CompletionItem[] = [];
        // ... (Environment and Rmd checks omitted) ...
        const trigger = completionContext.triggerCharacter;

        if (trigger === undefined) {
            // ... Populate from workspaceData.globalenv (fallback) ...
        } else if(trigger === '$' || trigger === '@') {
            const symbolPosition = new vscode.Position(position.line, position.character - 1);
            if (session.server) {
                const re = /([a-zA-Z0-9._$@ ])+(?<![@$])/;
                const exprRange = document.getWordRangeAtPosition(symbolPosition, re)?.with({ end: symbolPosition });
                const expr = document.getText(exprRange);
                
                // Request live completions from R via HTTP
                const response: RObjectElement[] = await session.sessionRequest(session.server, {
                    type: 'complete',
                    expr: expr,
                    trigger: completionContext.triggerCharacter
                });

                if (response) {
                    items.push(...getCompletionItemsFromElements(response, '[session]'));
                }
            } // ...
        }
        
        // ...
        return items;
    }
}
```
