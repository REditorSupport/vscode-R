#' Write a JSON object to the IPC pipe as a NDJSON line (internal)
#' @keywords internal
ipc_write <- function(data) {
  con <- .sess_env$con
  if (is.null(con)) return(invisible(FALSE))

  line <- paste0(jsonlite::toJSON(data, auto_unbox = TRUE, null = "null", force = TRUE), "\n")
  tryCatch(
    {
      remainder <- processx::conn_write(con, line)

      # processx::conn_write() may perform a partial write and return
      # remaining bytes; keep writing until all data is flushed.
      while (is.raw(remainder) && length(remainder) > 0) {
        remainder <- processx::conn_write(con, remainder)
      }

      invisible(TRUE)
    },
    error = function(e) {
      warning("[sess] Failed to send IPC message: ", e$message)
      invisible(FALSE)
    }
  )
}

#' Send a message to the client via IPC pipe (JSON-RPC 2.0)
#'
#' @param method String. The JSON-RPC method.
#' @param params List. The parameters for the method.
#' @param request Logical. If TRUE, sends a Request and waits for a Response.
#' @return The result of the request if request=TRUE, otherwise TRUE if sent.
#' @keywords internal
rpc_send <- function(method, params = list(), request = FALSE) {
  if (is.null(.sess_env$con)) {
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

  ipc_write(msg)

  if (!request) {
    invisible(TRUE)
  } else {
    # NON-BLOCKING WAIT:
    # Run later callbacks (which include poll_connection) while waiting for a response.
    while (is.null(.sess_env$pending_responses[[req_id]])) {
      later::run_now()
      Sys.sleep(0.01)
    }

    response <- .sess_env$pending_responses[[req_id]]
    .sess_env$pending_responses[[req_id]] <- NULL

    if (inherits(response, "json_rpc_error")) {
      stop(sprintf("JSON-RPC Error [%d]: %s", response$code, response$message))
    }

    response
  }
}

#' Notify the client via IPC pipe (JSON-RPC 2.0 Notification)
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
