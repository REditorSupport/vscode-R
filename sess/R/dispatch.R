#' Send a raw length-prefixed message over the stream
#' @keywords internal
send_msg <- function(stream, msg) {
  if (is.null(stream)) return(FALSE)
  payload <- jsonlite::toJSON(msg, auto_unbox = TRUE, null = "null", force = TRUE)
  payload_bytes <- charToRaw(payload)
  # 4-byte big-endian length prefix
  len_bytes <- writeBin(length(payload_bytes), raw(), size = 4, endian = "big")
  tryCatch({
    nanonext::send(stream, c(len_bytes, payload_bytes), mode = "raw")
    TRUE
  }, error = function(e) {
    warning("Failed to send IPC message: ", e$message)
    FALSE
  })
}

#' Send a message to the client (JSON-RPC 2.0)
#'
#' This is the internal workhorse for both Notifications and Requests.
#'
#' @param method String. The JSON-RPC method.
#' @param params List. The parameters for the method.
#' @param request Logical. If TRUE, sends a Request and waits for a Response.
#' @return The result of the request if request=TRUE, otherwise TRUE if sent.
#' @keywords internal
rpc_send <- function(method, params = list(), request = FALSE) {
  if (is.null(.sess_env$stream)) {
    return(invisible(FALSE))
  }

  msg <- list(
    jsonrpc = "2.0",
    method = method,
    params = params
  )

  req_id <- NULL
  if (request) {
    req_id <- basename(tempfile("req_", tmpdir = .sess_env$tempdir))
    msg$id <- req_id
  }

  # Send over the stream
  if (!send_msg(.sess_env$stream, msg)) {
    return(invisible(FALSE))
  }

  if (!request) {
    return(invisible(TRUE))
  }

  # NON-BLOCKING WAIT:
  # Process events in the background while blocking the R console execution
  # This prevents the R event loop from locking up.
  while (is.null(.sess_env$pending_responses[[req_id]])) {
    if (requireNamespace("later", quietly = TRUE)) {
      later::run_now(0.01)
    }
    nanonext::msleep(10)
  }

  # Retrieve and clean up response
  response <- .sess_env$pending_responses[[req_id]]
  .sess_env$pending_responses[[req_id]] <- NULL

  # Handle JSON-RPC Errors if any
  if (inherits(response, "json_rpc_error")) {
    stop(sprintf("JSON-RPC Error [%d]: %s", response$code, response$message))
  }

  response
}

#' Notify the client via IPC (JSON-RPC 2.0 Notification)
#'
#' Pushes an event instantly to the client extension via the active IPC connection.
#'
#' @param method A string representing the action (e.g., "dataview", "plot_updated")
#' @param params A list containing the arguments for the command
#' @export
notify_client <- function(method, params = list()) {
  rpc_send(method, params, request = FALSE)
}

#' Emulate rstudioapi (or any client action) synchronously but without blocking the R Event Loop
#'
#' @param action String of the action name
#' @param args List of arguments
#' @export
request_client <- function(action, args = list()) {
  rpc_send(action, args, request = TRUE)
}
