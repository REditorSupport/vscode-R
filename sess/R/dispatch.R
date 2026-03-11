#' Notify VS Code via WebSocket
#' 
#' Pushes an event instantly to the VS Code extension via the active WebSocket connection.
#'
#' @param command A string representing the action (e.g., "dataview", "plot_updated")
#' @param payload A list containing the arguments for the command
#' @export
notify_vscode <- function(command, payload = list()) {
  if (is.null(.sess_env$ws)) {
    return(FALSE) # No active client connected
  }
  
  msg <- list(
    command = command,
    payload = payload,
    time = format(Sys.time(), "%Y-%m-%d %H:%M:%OS6")
  )
  
  # Push instantly over the websocket
  tryCatch({
    .sess_env$ws$send(jsonlite::toJSON(msg, auto_unbox = TRUE, null = "null", force = TRUE))
    return(TRUE)
  }, error = function(e) {
    return(FALSE)
  })
}
