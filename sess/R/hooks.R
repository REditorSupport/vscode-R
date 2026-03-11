#' Register hooks for VS Code IPC
#'
#' @export
register_hooks <- function() {
  
  # 1. Override View() to push data directly via WebSocket
  rebind("View", function(x, title = deparse(substitute(x))) {
    # Dump to a temporary file locally so the payload size over WS isn't massive
    file_path <- tempfile(fileext = ".json")
    jsonlite::write_json(as.data.frame(x), file_path, auto_unbox = TRUE, null = "null", na = "string")
    
    notify_vscode("dataview", list(
      title = title,
      file = file_path,
      source = "table",
      type = "json"
    ))
  }, ns = "utils")
  
  # 2. Browser & Webview Options
  show_browser <- function(url, title = url, ...) {
    notify_vscode("browser", list(url = url, title = title))
  }
  
  show_webview <- function(url, title = "WebView", ...) {
    # If the URL is a local file, normalize its path for the webview
    if (file.exists(url)) {
      url <- normalizePath(url, "/", mustWork = TRUE)
    }
    notify_vscode("webview", list(file = url, title = title))
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
        notify_vscode("help", list(requestPath = requestPath))
    }
    invisible(x)
  }, ns = "utils")
  
  rebind("print.hsearch", function(x, ...) {
    if (length(x) >= 1) {
        requestPath <- paste0("/doc/html/Search?pattern=", tools:::escapeAmpersand(x$pattern))
        notify_vscode("help", list(requestPath = requestPath))
    }
    invisible(x)
  }, ns = "utils")

  # 4. httpgd or Static Plot Hook
  use_httpgd <- isTRUE(getOption("vsc.use_httpgd", FALSE))
  if (use_httpgd && requireNamespace("httpgd", quietly = TRUE)) {
    options(device = function(...) {
        httpgd::hgd(silent = TRUE)
        notify_vscode("httpgd", list(url = httpgd::hgd_url()))
    })
  } else {
    # Default to static plot capturing
    setHook("plot.new", function(...) {
      notify_vscode("plot_updated", list(url = "/plot/latest.png"))
    }, "replace")
    
    setHook("grid.newpage", function(...) {
      notify_vscode("plot_updated", list(url = "/plot/latest.png"))
    }, "replace")
  }
}

#' Emulate rstudioapi synchronously but without blocking the R Event Loop
#'
#' @param action String of the rstudioapi action
#' @param args List of arguments
#' @export
request_rstudioapi <- function(action, args = list()) {
  req_id <- basename(tempfile("req_"))
  
  # Send request via websocket
  notify_vscode("rstudioapi", list(
    req_id = req_id,
    action = action,
    args = args
  ))
  
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
  
  return(response)
}