// esbuild embeds the generated resource in each runtime bundle. Node tests load
// it from dist after the normal compile step.
const nativeViewerSource = require('../../dist/resources/webr-viewers.json') as string;

export const viewerRunner = String.raw`
base::local({
${nativeViewerSource}

    .sess_env <- new.env(parent = emptyenv())
    .sess_env$tempdir <- tempdir()
    .sess_env$interactive_connected <- TRUE
    .sess_env$dataview_registry <- new.env(parent = emptyenv())

    # Keep payloads as data throughout the bridge. JS reads a complete JSON
    # envelope from an R-owned file while R is paused in eval_js().
    send <- function(type, data) {
        json <- ipc_json(list(type = type, data = data))
        if (nchar(json, type = "bytes") > 2 * 1024^2)
            stop("Rich output exceeds 2 MiB. Display a smaller preview.")
        file <- tempfile("vscode-view-")
        on.exit(unlink(file))
        writeBin(charToRaw(enc2utf8(as.character(json))), file)
        file_json <- jsonlite::toJSON(file, auto_unbox = TRUE)
        webr::eval_js(paste0("(globalThis.Module.webr.channel.write(JSON.parse(",
            "globalThis.Module.FS.readFile(", file_json, ", {encoding:'utf8'}))), null)"))
        invisible(TRUE)
    }
    .interactive_event <- function(type, data) send("vscode-r-display", data)
    .interactive_rich_value <- .interactive_viewer_value
    notify_client <- function(method, params) {
        if (!identical(method, "dataview") || !params$source %in% c("table", "list"))
            stop("webR supports table, list and vector viewers.")
        send("vscode-r-viewer", list(method = method, params = params))
    }

    # Replace both the attached export and the namespace export in this worker.
    # A user's own View binding in .GlobalEnv retains its usual precedence.
    for (env in list(asNamespace("utils"), as.environment("package:utils"))) {
        locked <- bindingIsLocked("View", env)
        if (locked) unlockBinding("View", env)
        tryCatch(assign("View", show_dataview, env), finally = if (locked) lockBinding("View", env))
    }

    handlers <- inspection_handlers()[c("workspace_children", "listview_navigate", "listview_view",
        "dataview_init", "dataview_page", "dataview_dispose")]
    inspect <- function(method, json) {
        if (!is.character(method) || length(method) != 1L || !method %in% names(handlers))
            stop("Unsupported webR viewer request.")
        params <- inspection_validate(method, inspection_decode(json))
        if (method == "workspace_children" && is.null(params$view_id))
            stop("List inspection requires a retained view ID.")
        if (method == "dataview_page") {
            start <- params$startRow %||% 0L
            end <- params$endRow %||% (start + 500L)
            if (start < 0 || end < start || end - start > 500L || end > .Machine$integer.max)
                stop("Invalid table page. Request at most 500 rows.")
        }
        inspection_encode(handlers[[method]](params))
    }
    options(vscodeR.webR.richValue = .interactive_viewer_value, vscodeR.webR.inspect = inspect)
}, envir = base::new.env(parent = base::asNamespace("utils")))
`;
