#' Connect to the VS Code IPC server
#'
#' @param endpoint Character. Local named pipe / Unix domain socket endpoint.
#'   If NULL, uses SESS_ENDPOINT, then SESS_DISCOVERY_FILE.
#' @param use_rstudioapi Logical. Enable rstudioapi emulation. Defaults to TRUE.
#' @param use_httpgd Logical. Use httpgd for plotting if available. Defaults to TRUE.
#' @param use_jgd Logical. Use jgd for plotting if available. Defaults to FALSE.
#' @export
connect <- function(endpoint = NULL, use_rstudioapi = TRUE, use_httpgd = TRUE, use_jgd = FALSE) {
  # Invalidate poll callbacks and restore a previous runtime before reconnecting.
  .transport_disconnect(silent = TRUE)
  .sess_env$con <- NULL
  .sess_env$pending_responses <- list()
  .sess_env$read_buffer <- ""
  .sess_env$dataviews <- list()
  if (is.null(.sess_env$dataview_registry)) {
    .sess_env$dataview_registry <- new.env(parent = emptyenv())
  }

  .sess_env$tempdir <- file.path(tempdir(), "sess")
  dir.create(.sess_env$tempdir, showWarnings = FALSE, recursive = TRUE)

  .sess_env$latest_plot_path <- file.path(.sess_env$tempdir, "sess_plot.png")

  endpoint <- .resolve_endpoint(endpoint)
  if (!nzchar(endpoint)) {
    warning("[sess] Connection info not available. Cannot connect to VS Code.")
    return(invisible(NULL))
  }

  # processx uses the \\?\pipe\ namespace on Windows.
  # Normalize \\.\pipe\* paths from Node.js to improve compatibility.
  if (.Platform$OS.type == "windows") {
    if (startsWith(endpoint, "\\\\.\\pipe\\")) {
      endpoint <- sub("^\\\\\\\\\\.\\\\pipe\\\\", "\\\\\\\\?\\\\pipe\\\\", endpoint)
    }
  }

  print_async_msg <- function(msg) {
    prompt <- if (interactive()) getOption("prompt") else ""
    cat(sprintf("\r%s\n\n%s", msg, prompt))
  }

  do_connect <- function() {
    con <- tryCatch(
      processx::conn_connect_unix_socket(endpoint, encoding = ""),
      error = function(e) {
        print_async_msg(sprintf("[sess] Failed to connect to IPC endpoint: %s", e$message))
        NULL
      }
    )
    if (is.null(con)) return(FALSE)

    .sess_env$con <- con

    # session_id is stable across reconnects during this R process lifetime.
    notify_client("attach", .session_attach_metadata())

    if (is.null(.sess_env$con)) return(FALSE)

    print_async_msg("[sess] Connected to VS Code")

    # Start the polling loop
    poll_connection(.sess_env$transport_generation)
    TRUE
  }

  connected <- do_connect()

  if (is.na(use_rstudioapi)) use_rstudioapi <- TRUE
  if (is.na(use_httpgd)) use_httpgd <- TRUE
  if (is.na(use_jgd)) use_jgd <- FALSE
  if (isTRUE(connected) && !is.null(.sess_env$con)) {
    tryCatch(
      runtime_start(use_rstudioapi = use_rstudioapi,
                    use_httpgd = use_httpgd,
                    use_jgd = use_jgd),
      error = function(e) {
        phase <- .sess_env$runtime_start_phase
        error_call <- conditionCall(e)
        call_text <- if (is.null(error_call)) {
          ""
        } else {
          paste(deparse(error_call), collapse = " ")
        }
        call_suffix <- if (nzchar(call_text)) {
          paste0(" (", call_text, ")")
        } else {
          ""
        }
        message(
          "[sess] Runtime startup failed during ", phase, ": ",
          conditionMessage(e), call_suffix
        )
        stop(e)
      },
      finally = {
        .sess_env$runtime_start_phase <- NULL
      }
    )
  }

  invisible(NULL)
}

# Resolve the direct argument, environment variables, then discovery data.
.resolve_endpoint <- function(endpoint = NULL,
                              env_endpoint = Sys.getenv("SESS_ENDPOINT"),
                              env_discovery_file = Sys.getenv("SESS_DISCOVERY_FILE")) {
  if (!is.null(endpoint) && length(endpoint) == 1L && !is.na(endpoint) && nzchar(endpoint)) {
    return(endpoint)
  }
  if (length(env_endpoint) == 1L && !is.na(env_endpoint) && nzchar(env_endpoint)) {
    return(env_endpoint)
  }

  # An explicit discovery path is authoritative. If it is missing or
  # incompatible, do not connect using a stale endpoint.
  if (length(env_discovery_file) == 1L && !is.na(env_discovery_file) &&
        nzchar(env_discovery_file)) {
    return(.read_discovery_endpoint(env_discovery_file, warn = TRUE))
  }
  ""
}

.read_discovery_endpoint <- function(path, warn = FALSE) {
  warn_problem <- function(message) {
    if (isTRUE(warn)) warning("[sess] ", message, call. = FALSE)
    ""
  }
  is_endpoint <- function(value) {
    is.character(value) && length(value) == 1L && !is.na(value) && nzchar(value)
  }
  if (!file.exists(path)) {
    if (isTRUE(warn)) {
      return(warn_problem(sprintf(
        paste0(
          "Session discovery file '%s' does not exist. ",
          "Check SESS_DISCOVERY_FILE or restart the R terminal."
        ),
        path
      )))
    }
    return(NULL)
  }

  tryCatch({
    cfg <- jsonlite::fromJSON(readLines(path, warn = FALSE), simplifyVector = FALSE)
    if (!is.list(cfg)) {
      return(warn_problem(sprintf(
        "Invalid session discovery data in '%s'; expected a JSON object.",
        path
      )))
    }

    if (is.null(cfg$version)) {
      return(warn_problem(sprintf(
        paste0(
          "Session discovery file '%s' has no supported schema version; ",
          "expected version 1 with an endpoint field."
        ),
        path
      )))
    }

    version <- cfg$version
    if (!identical(version, 1L)) {
      return(warn_problem(sprintf(
        paste0(
          "Unsupported session discovery version '%s' in '%s'; ",
          "update vscode-R or use a version 1 discovery file."
        ),
        paste(cfg$version, collapse = ", "), path
      )))
    }

    value <- cfg$endpoint
    if (!is_endpoint(value)) {
      return(warn_problem(sprintf(
        "Session discovery file '%s' has no endpoint; check the vscode-R session setup.",
        path
      )))
    }
    value
  }, error = function(e) {
    warn_problem(sprintf(
      "Could not read session discovery file '%s': %s",
      path,
      conditionMessage(e)
    ))
  })
}

.session_attach_metadata <- function() {
  host <- Sys.info()[["nodename"]]
  if (is.null(host) || is.na(host)) host <- ""
  list(
    protocol_version = 1L,
    sess_version = as.character(utils::packageVersion("sess")),
    session_id = .session_id(),
    host = unname(host),
    version = sprintf("%s.%s", R.version$major, R.version$minor),
    pid = Sys.getpid(),
    tempdir = .sess_env$tempdir,
    wd = getwd(),
    info = list(
      command = commandArgs()[[1L]],
      version = R.version.string,
      start_time = format(Sys.time())
    )
  )
}

.transport_disconnect <- function(silent = FALSE) {
  con <- .sess_env$con
  .sess_env$con <- NULL
  .sess_env$transport_generation <- if (is.null(.sess_env$transport_generation)) {
    1L
  } else {
    .sess_env$transport_generation + 1L
  }
  .sess_env$read_buffer <- ""
  .sess_env$pending_responses <- list()

  if (!is.null(con)) try(close(con), silent = TRUE)
  runtime_stop()
  if (!silent && !is.null(con)) message("[sess] Disconnected from VS Code")
  invisible(NULL)
}

.transport_empty_read_is_eof <- function(con) {
  # A ready poll can race with a read that finds no bytes. Treat only a
  # connection known to have reached EOF as disconnected; processx documents
  # conn_is_incomplete() as FALSE once no more data can arrive.
  incomplete <- tryCatch(
    processx::conn_is_incomplete(con),
    error = function(e) TRUE
  )
  identical(incomplete, FALSE)
}

#' Poll the IPC connection for incoming messages (internal)
#'
#' Runs as a recurring later callback; dispatches NDJSON messages from vscode.
#' @keywords internal
poll_connection <- function(generation = .sess_env$transport_generation) {
  con <- .sess_env$con
  if (is.null(con) || !identical(generation, .sess_env$transport_generation)) return()

  # Non-blocking poll: 0 ms timeout
  ready <- tryCatch(
    processx::poll(list(con), 0L),
    error = function(e) {
      .transport_disconnect(silent = TRUE)
      NULL
    }
  )

  if (is.null(.sess_env$con) ||
        !identical(generation, .sess_env$transport_generation)) {
    return()
  }

  # A NULL poll result is transient; keep the loop alive and reschedule below.
  if (!is.null(ready) && length(ready) > 0 && identical(ready[[1]], "ready")) {
    chunk <- tryCatch(
      processx::conn_read_chars(con),
      error = function(e) {
        .transport_disconnect(silent = TRUE)
        NULL
      }
    )

    if (is.null(.sess_env$con)) return()
    has_data <- !is.null(chunk) && length(chunk) > 0L && any(nzchar(chunk))
    if (!has_data) {
      if (.transport_empty_read_is_eof(con)) {
        .transport_disconnect(silent = TRUE)
        return()
      }
    } else {
      .sess_env$read_buffer <- paste0(.sess_env$read_buffer, paste0(chunk, collapse = ""))
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
  } else if (length(ready) > 0 && ready[[1]] %in% c("closed", "error")) {
    .transport_disconnect(silent = TRUE)
    return()
  }

  if (!is.null(.sess_env$con) && identical(generation, .sess_env$transport_generation)) {
    later::later(function() poll_connection(generation), 0.01)
  }
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
      "workspace_children" = function(p) get_workspace_children(p$name, p$path, p$start),
      "hover" = function(p) handle_hover(p$expr),
      "completion" = function(p) handle_complete(p$expr, p$trigger),
      "plot_latest" = function(p) handle_plot_latest(p),
      "dataview_init" = function(p) handle_dataview_init(p),
      "dataview_page" = function(p) handle_dataview_page(p),
      "dataview_dispose" = function(p) handle_dataview_dispose(p)
    )

    if (payload$method %in% names(handlers)) {
      tryCatch(
        {
          res <- handlers[[payload$method]](payload$params)
          rpc_reply(payload$id, result = res)
        },
        error = function(e) {
          rpc_reply(payload$id, error = list(code = -32603L, message = conditionMessage(e)))
          warning(sprintf("[sess] Error in handler for '%s': %s", payload$method, e$message))
        }
      )
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
