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
  
  # 2. Static Plot Hook
  # Instead of relying on plot.lock file watchers, we tell VS Code a new plot is ready to fetch.
  setHook("plot.new", function(...) {
    notify_vscode("plot_updated", list(url = "/plot/latest.png"))
  }, "replace")
  
  setHook("grid.newpage", function(...) {
    notify_vscode("plot_updated", list(url = "/plot/latest.png"))
  }, "replace")
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
  while (is.null(.vscr_env$pending_responses[[req_id]])) {
    httpuv::service() 
    Sys.sleep(0.05)
  }
  
  # Retrieve and clean up response
  response <- .vscr_env$pending_responses[[req_id]]
  .vscr_env$pending_responses[[req_id]] <- NULL
  
  return(response)
}