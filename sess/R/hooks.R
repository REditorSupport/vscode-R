#' Register hooks for the client IPC
#'
#' @param use_rstudioapi Logical. Enable rstudioapi emulation.
#' @param use_httpgd Logical. Enable httpgd plot device if available.
#' @export
register_hooks <- function(use_rstudioapi = TRUE, use_httpgd = FALSE) {
  
  # 1. Override View() to push data directly via WebSocket
  rebind("View", function(x, title = deparse(substitute(x))) {
    # Dump to a temporary file locally so the payload size over WS isn't massive
    file_path <- tempfile(fileext = ".json")
    jsonlite::write_json(as.data.frame(x), file_path, auto_unbox = TRUE, null = "null", na = "string")
    
    notify_client("dataview", list(
      title = title,
      file = file_path,
      source = "table",
      type = "json"
    ))
  }, ns = "utils")
  
  # 2. Browser & Webview Options
  show_browser <- function(url, title = url, ...) {
    notify_client("browser", list(url = url, title = title))
  }
  
  show_webview <- function(url, title = "WebView", ...) {
    # If the URL is a local file, normalize its path for the webview
    if (file.exists(url)) {
      url <- normalizePath(url, "/", mustWork = TRUE)
    }
    notify_client("webview", list(file = url, title = title))
  }
  
  options(
    browser = show_browser,
    viewer = show_webview,
    page_viewer = show_webview,
    help_type = "html"
  )

  # 3. Help System Interception
  rebind("print.help_files_with_topic", function(x, ...) {
    if (length(x) >= 1 && is.character(x)) {
        file <- x[1]
        pkgname <- basename(dirname(dirname(file)))
        requestPath <- paste0("/library/", pkgname, "/html/", basename(file), ".html")
        notify_client("help", list(requestPath = requestPath))
    }
    invisible(x)
  }, ns = "utils")
  
  rebind("print.hsearch", function(x, ...) {
    if (length(x) >= 1) {
        requestPath <- paste0("/doc/html/Search?pattern=", tools:::escapeAmpersand(x$pattern))
        notify_client("help", list(requestPath = requestPath))
    }
    invisible(x)
  }, ns = "utils")

  # 4. httpgd or Static Plot Hook
  if (use_httpgd && requireNamespace("httpgd", quietly = TRUE)) {
    options(device = function(...) {
        httpgd::hgd(silent = TRUE)
        notify_client("httpgd", list(url = httpgd::hgd_url()))
    })
  } else {
    # Default to static plot capturing
    options(device = function(...) {
      png(.sess_env$latest_plot_path, width = 800, height = 600, res = 72)
    })

    setHook("plot.new", function(...) {
      notify_client("plot_updated")
    }, "replace")
    
    setHook("grid.newpage", function(...) {
      notify_client("plot_updated")
    }, "replace")
  }

  # 5. rstudioapi hooks
  if (use_rstudioapi) {
    setHook(packageEvent("rstudioapi", "onLoad"), function(...) {
      patch_rstudioapi()
    }, action = "append")
    
    if ("rstudioapi" %in% loadedNamespaces()) {
        patch_rstudioapi()
    }
  }
}

#' Emulate rstudioapi synchronously but without blocking the R Event Loop
#'
#' @param action String of the rstudioapi action
#' @param args List of arguments
#' @export
request_rstudioapi <- function(action, args = list()) {
  req_id <- basename(tempfile("req_"))
  
  # Send JSON-RPC 2.0 Request via websocket
  msg <- list(
    jsonrpc = "2.0",
    id = req_id,
    method = "rstudioapi",
    params = list(
        action = action,
        args = args
    )
  )

  if (!is.null(.sess_env$ws)) {
    tryCatch({
        .sess_env$ws$send(jsonlite::toJSON(msg, auto_unbox = TRUE, null = "null", force = TRUE))
    }, error = function(e) return(NULL))
  } else {
    return(NULL)
  }
  
  # NON-BLOCKING WAIT:
  # Process HTTP/WS events in the background while blocking the R console execution
  # This prevents the R event loop from locking up.
  while (is.null(.sess_env$pending_responses[[req_id]])) {
    httpuv::service() 
    Sys.sleep(0.05)
  }
  
  # Retrieve and clean up response
  response <- .sess_env$pending_responses[[req_id]]
  .sess_env$pending_responses[[req_id]] <- NULL
  
  # Handle JSON-RPC Errors if any
  if (inherits(response, "json_rpc_error")) {
    stop(sprintf("JSON-RPC Error [%d]: %s", response$code, response$message))
  }
  
  return(response)
}