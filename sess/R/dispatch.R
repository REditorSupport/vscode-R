#' Notify the client via WebSocket (JSON-RPC 2.0 Notification)
#' 
#' Pushes an event instantly to the client extension via the active WebSocket connection.
#'
#' @param method A string representing the action (e.g., "dataview", "plot_updated")
#' @param params A list containing the arguments for the command
#' @export
notify_client <- function(method, params = list()) {
  if (is.null(.sess_env$ws)) {
    return(FALSE) # No active client connected
  }
  
  msg <- list(
    jsonrpc = "2.0",
    method = method,
    params = params
  )
  
  # Push instantly over the websocket
  tryCatch({
    .sess_env$ws$send(jsonlite::toJSON(msg, auto_unbox = TRUE, null = "null", force = TRUE))
    return(TRUE)
  }, error = function(e) {
    return(FALSE)
  })
}
