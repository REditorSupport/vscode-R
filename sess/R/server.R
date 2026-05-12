#' Connect to the VS Code IPC server
#'
#' @param pipe_path Character. Path to the named pipe / Unix domain socket.
#'   If NULL, uses the SESS_PIPE environment variable, then falls back to the
#'   session JSON file written by the extension.
#' @param use_rstudioapi Logical. Enable rstudioapi emulation. Defaults to TRUE.
#' @param use_httpgd Logical. Use httpgd for plotting if available. Defaults to TRUE.
#' @param use_jgd Logical. Use jgd for plotting if available. Defaults to FALSE.
#' @export
connect <- function(pipe_path = NULL, use_rstudioapi = TRUE, use_httpgd = TRUE, use_jgd = FALSE) {
  .sess_env$con <- NULL
  .sess_env$pending_responses <- list()
  .sess_env$read_buffer <- ""
  .sess_env$dataviews <- list()

  .sess_env$tempdir <- file.path(tempdir(), "sess")
  dir.create(.sess_env$tempdir, showWarnings = FALSE, recursive = TRUE)

  .sess_env$latest_plot_path <- file.path(.sess_env$tempdir, "sess_plot.png")

  is_manual <- !is.null(pipe_path) && !is.na(pipe_path) && nzchar(pipe_path)

  if (is.null(pipe_path) || is.na(pipe_path)) {
    pipe_path <- Sys.getenv("SESS_PIPE")
  }

  # Fallback: read from session JSON file written by the extension
  pid <- Sys.getpid()
  home <- path.expand("~")
  file_path <- file.path(home, ".vscode-R", "sessions", sprintf("%d.json", pid))

  if (!nzchar(pipe_path)) {
    if (file.exists(file_path)) {
      tryCatch({
        cfg <- jsonlite::fromJSON(readLines(file_path, warn = FALSE))
        pipe_path <- cfg$pipe
      }, error = function(e) NULL)
    }
  }

  if (!nzchar(pipe_path)) {
    warning("[sess] Connection info not available. Cannot connect to VS Code.")
    return(invisible(NULL))
  }

  # processx uses the \\?\pipe\ namespace on Windows.
  # Normalize \\.\pipe\* paths from Node.js to improve compatibility.
  if (.Platform$OS.type == "windows") {
    if (startsWith(pipe_path, "\\\\.\\pipe\\")) {
      pipe_path <- sub("^\\\\\\\\\\.\\\\pipe\\\\", "\\\\\\\\?\\\\pipe\\\\", pipe_path)
    }
  }

  print_async_msg <- function(msg) {
    prompt <- if (interactive()) getOption("prompt") else ""
    cat(sprintf("\r%s\n\n%s", msg, prompt))
  }

  do_connect <- function() {
    con <- tryCatch(
      processx::conn_connect_unix_socket(pipe_path, encoding = ""),
      error = function(e) {
        print_async_msg(sprintf("[sess] Failed to connect to IPC pipe: %s", e$message))
        NULL
      }
    )
    if (is.null(con)) return()

    .sess_env$con <- con

    # Send attach handshake
    notify_client("attach", list(
      version = sprintf("%s.%s", R.version$major, R.version$minor),
      pid = Sys.getpid(),
      tempdir = .sess_env$tempdir,
      wd = getwd(),
      info = list(
        command = commandArgs()[[1L]],
        version = R.version.string,
        start_time = format(Sys.time())
      )
    ))

    print_async_msg("[sess] Connected to VS Code")

    # Start the polling loop
    poll_connection()
  }

  do_connect()

  if (is.na(use_rstudioapi)) use_rstudioapi <- TRUE
  if (is.na(use_httpgd)) use_httpgd <- TRUE
  if (is.na(use_jgd)) use_jgd <- FALSE
  register_hooks(use_rstudioapi = use_rstudioapi, use_httpgd = use_httpgd, use_jgd = use_jgd)

  invisible(NULL)
}

#' Poll the IPC connection for incoming messages (internal)
#'
#' Runs as a recurring later callback; dispatches NDJSON messages from vscode.
#' @keywords internal
poll_connection <- function() {
  con <- .sess_env$con
  if (is.null(con)) return()

  # Non-blocking poll: 0 ms timeout
  ready <- tryCatch(
    processx::poll(list(con), 0L),
    error = function(e) NULL
  )

  if (!is.null(ready) && length(ready) > 0 && identical(ready[[1]], "ready")) {
    chunk <- tryCatch(
      processx::conn_read_chars(con),
      error = function(e) {
        .sess_env$con <- NULL
        NULL
      }
    )

    if (!is.null(chunk) && nzchar(chunk)) {
      .sess_env$read_buffer <- paste0(.sess_env$read_buffer, chunk)
      parts <- strsplit(.sess_env$read_buffer, "\n", fixed = TRUE)[[1]]

      n <- length(parts)
      # Keep any trailing partial line in the buffer
      if (endsWith(.sess_env$read_buffer, "\n")) {
        .sess_env$read_buffer <- ""
      } else {
        .sess_env$read_buffer <- parts[n]
        parts <- parts[-n]
      }

      for (line in parts) {
        line <- trimws(line)
        if (!nzchar(line)) next
        tryCatch(
          dispatch_message(line),
          error = function(e) {
            warning("[sess] Error dispatching message: ", e$message)
          }
        )
      }
    }
  }

  later::later(poll_connection, 0.01)
}

#' Dispatch a single NDJSON line as a JSON-RPC message (internal)
#' @keywords internal
dispatch_message <- function(line) {
  payload <- tryCatch(jsonlite::fromJSON(line, simplifyVector = FALSE), error = function(e) NULL)
  if (is.null(payload)) return(invisible(NULL))

  has_id <- !is.null(payload$id)
  has_method <- !is.null(payload$method)

  if (has_id && !has_method) {
    # Response to a request we sent
    key <- as.character(payload$id)
    if (!is.null(payload$result)) {
      .sess_env$pending_responses[[key]] <- payload$result
    } else if (!is.null(payload$error)) {
      .sess_env$pending_responses[[key]] <-
        structure(payload$error, class = "json_rpc_error")
    }
  } else if (has_method && has_id) {
    # Request from vscode → R must reply
    handlers <- list(
      "workspace" = function(p) get_workspace_data(),
      "hover" = function(p) handle_hover(p$expr),
      "completion" = function(p) handle_complete(p$expr, p$trigger),
      "plot_latest" = function(p) handle_plot_latest(p),
      "dataview_init" = function(p) handle_dataview_init(p),
      "dataview_page" = function(p) handle_dataview_page(p),
      "dataview_dispose" = function(p) handle_dataview_dispose(p)
    )

    if (payload$method %in% names(handlers)) {
      res <- tryCatch(
        handlers[[payload$method]](payload$params),
        error = function(e) {
          warning(sprintf("[sess] Error in handler for '%s': %s", payload$method, e$message))
          NULL
        }
      )
      rpc_reply(payload$id, result = res)
    } else {
      rpc_reply(payload$id, error = list(code = -32601L, message = "Method not found"))
    }
  }
  # has_method && !has_id: unsolicited notification from vscode — ignore gracefully
  invisible(NULL)
}

#' Send a JSON-RPC reply to a request (internal)
#' @keywords internal
rpc_reply <- function(id, result = NULL, error = NULL) {
  msg <- list(jsonrpc = "2.0", id = id)
  if (!is.null(error)) msg$error <- error else msg$result <- result
  ipc_write(msg)
}
