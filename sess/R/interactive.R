# Rich events use pure R IPC; small stdout markers preserve console ordering.
.interactive_event <- function(type, data = list()) {
  if (!identical(.sess_env$interactive_pid, Sys.getpid())) return(invisible(NULL))
  id <- .sess_env$interactive_id
  event <- c(list(type = type, executionId = if (is.null(id)) "" else id), data)
  json <- as.character(jsonlite::toJSON(
    event, auto_unbox = TRUE, null = "null", na = "null", digits = NA
  ))
  # Bound encoded events before writing to the agent transport.
  # Agent-side display limits run only after parsing and cannot protect it from
  # oversized HTML, wide tables, or strings enlarged by JSON escaping.
  if (nchar(json, type = "bytes") > 2 * 1024 * 1024) {
    json <- as.character(jsonlite::toJSON(list(
      type = "truncated", executionId = if (is.null(id)) "" else id,
      message = "Rich output exceeds 2 MiB; display a smaller preview or save it to a file."
    ), auto_unbox = TRUE))
  }
  if (isTRUE(.sess_env$interactive_managed)) {
    .sess_env$interactive_event_counter <- .sess_env$interactive_event_counter + 1L
    event_id <- .sess_env$interactive_event_counter
    rpc_send("interactive_event", list(eventId = event_id,
                                       event = jsonlite::fromJSON(json, simplifyVector = FALSE)))
    reference <- jsonlite::toJSON(list(type = "event", eventId = event_id), auto_unbox = TRUE)
    encoded <- jsonlite::base64_enc(charToRaw(reference))
    marker <- paste0("\036", .sess_env$interactive_token, ":", encoded, "\037")
    # A stderr fence ensures the agent drains both pipes before finishing a cell.
    if (type == "finished") {
      fence <- paste0("\036", .sess_env$interactive_token, ":",
                      jsonlite::base64_enc(charToRaw('{"type":"flush"}')), "\037")
      .interactive_write(.sess_env$interactive_stderr, fence)
    }
    .interactive_write(.sess_env$interactive_stdout, marker)
  } else {
    rpc_send("interactive_event", jsonlite::fromJSON(json, simplifyVector = FALSE))
  }
  invisible(NULL)
}

.interactive_write <- function(connection, text) {
  remaining <- processx::conn_write(connection, charToRaw(enc2utf8(text)))
  while (is.raw(remaining) && length(remaining)) {
    remaining <- processx::conn_write(connection, remaining)
  }
  invisible(NULL)
}

.interactive_plot_context <- function(open_group = TRUE) {
  if (requireNamespace("jgd", quietly = TRUE) &&
        "jgd" %in% names(grDevices::dev.list())) {
    id <- .sess_env$interactive_id
    context <- as.character(jsonlite::toJSON(
      list(executionId = if (is.null(id)) "" else id,
           vscodeRExecutionId = if (is.null(id)) "" else id), auto_unbox = TRUE
    ))
    if (!is.null(id)) {
      if (!identical(names(grDevices::dev.cur()), "jgd")) return(invisible(NULL))
      try(jgd::jgd_frame_ext(context), silent = TRUE)
      device <- as.integer(grDevices::dev.cur())
      if (open_group && !device %in% .sess_env$interactive_plot_groups) {
        try(jgd::jgd_begin_group(context), silent = TRUE)
        .sess_env$interactive_plot_groups <- c(.sess_env$interactive_plot_groups, device)
      }
    } else {
      selected <- grDevices::dev.cur()
      if (identical(names(selected), "jgd")) try(jgd::jgd_frame_ext(context), silent = TRUE)
      devices <- grDevices::dev.list()
      for (device in intersect(.sess_env$interactive_plot_groups,
                               devices[names(devices) == "jgd"])) {
        grDevices::dev.set(device)
        try(jgd::jgd_end_group(), silent = TRUE)
        try(jgd::jgd_frame_ext(context), silent = TRUE)
      }
      if (selected %in% grDevices::dev.list()) grDevices::dev.set(selected)
      .sess_env$interactive_plot_groups <- integer()
    }
  }
}

.interactive_plot_new_page <- function() {
  device <- as.integer(grDevices::dev.cur())
  if (identical(names(grDevices::dev.cur()), "jgd") &&
        device %in% .sess_env$interactive_plot_groups) {
    # Close our execution marker before JGD resets its groups at a page boundary.
    try(jgd::jgd_end_group(), silent = TRUE)
    .sess_env$interactive_plot_groups <- setdiff(.sess_env$interactive_plot_groups, device)
  }
}

#' Connect an existing R frontend to a persistent Interactive agent
#'
#' @param config Path to the private JSON bootstrap configuration created by the agent.
#' @param managed Whether the agent owns the arf process and its output pipes.
#' @keywords internal
interactive_start <- function(config, managed = FALSE) {
  if (isTRUE(.sess_env$interactive_connected)) {
    stop("This R process already belongs to an Interactive agent")
  }
  cfg <- jsonlite::read_json(config, simplifyVector = TRUE)
  if (!interactive()) stop("The Interactive worker requires an interactive R frontend")
  options(sess.quiet = TRUE)
  .sess_env$interactive_token <- cfg$token
  Sys.setenv(JGD_SOCKET = cfg$jgd, SESS_ENDPOINT = cfg$sess)
  connect(endpoint = cfg$sess, plot_backend = if (isTRUE(cfg$useJgd)) "jgd" else "standard")
  if (is.null(.sess_env$con)) stop("Could not connect to the session agent")
  .sess_env$interactive_pid <- Sys.getpid()
  .sess_env$interactive_managed <- managed
  .sess_env$interactive_event_counter <- 0L
  if (managed) {
    # Write protocol frames directly, independent of sinks and frontend styling.
    # These wrappers do not own stdout/stderr; never explicitly close them.
    .sess_env$interactive_stdout <- processx::conn_create_fd(1L, close = FALSE)
    .sess_env$interactive_stderr <- processx::conn_create_fd(2L, close = FALSE)
  }
  .sess_env$interactive_connected <- TRUE
  .sess_env$interactive_id <- NULL
  .sess_env$interactive_plot_groups <- integer()
  .sess_env$interactive_seen <- new.env(parent = emptyenv())
  .sess_env$interactive_stop <- FALSE
  .sess_env$interactive_static <- !isTRUE(cfg$useJgd)
  .sess_env$interactive_last_plot <- NULL
  .sess_env$interactive_plot_page <- 0L
  .sess_env$interactive_last_plot_page <- NULL
  .sess_env$interactive_last_plot_data <- NULL
  if (isTRUE(cfg$useJgd)) {
    select_device <- grDevices::dev.set
    .runtime_rebind("dev.set", function(which = grDevices::dev.next()) {
      result <- select_device(which)
      if (!is.null(.sess_env$interactive_id)) .interactive_plot_context()
      invisible(result)
    }, ns = "grDevices")
  }
  # Hooks also run through references already imported by stats/lattice.
  # Rebinding plot.new/grid.newpage misses those references and loses pages.
  for (name in c("plot.new", "grid.newpage")) {
    before_page <- local({
      grid_page <- identical(name, "grid.newpage")
      function() {
        if (isTRUE(.sess_env$interactive_static)) {
          current <- grDevices::dev.cur()
          owned <- current == 1L || current == getOption("sess.null_dev", -1L)
          # plot.new is also called for each panel of mfrow/mfcol/layout.
          new_page <- !isTRUE(.sess_env$interactive_capturing) && owned &&
            (grid_page || current == 1L || isTRUE(graphics::par("page")))
          if (new_page) {
            .interactive_capture_plot()
            .sess_env$interactive_plot_page <- .sess_env$interactive_plot_page + 1L
            .sess_env$interactive_last_plot <- NULL
          }
        } else {
          .interactive_plot_new_page()
        }
      }
    })
    .runtime_set_hook(paste0("before.", name), before_page, "append")
    if (isTRUE(cfg$useJgd)) {
      .runtime_set_hook(name, .interactive_plot_context, "append")
    }
  }
  device <- getOption("device")
  if (is.function(device)) {
    options(device = local({
      original <- device
      function(...) {
        original(...)
        .interactive_plot_context(open_group = FALSE)
      }
    }))
  }
  if (!managed) {
    .sess_env$interactive_skip_task <- TRUE
    .sess_env$interactive_task <- addTaskCallback(function(expr, value, ok, visible) {
      if (isTRUE(.sess_env$interactive_skip_task)) {
        .sess_env$interactive_skip_task <- FALSE
        return(TRUE)
      }
      if (is.null(.sess_env$interactive_id)) {
        .interactive_event("external", list(code = paste(deparse(expr), collapse = "\n"),
                                            success = ok))
      }
      TRUE
    })
  }
  .interactive_event("ready", list(pid = Sys.getpid(), version = R.version.string,
                                   rPath = file.path(R.home("bin"), "R"),
                                   libraryPaths = as.list(.libPaths()),
                                   sessionId = .session_id(), nativeConsole = FALSE))
  invisible(NULL)
}

#' Evaluate an execution admitted by a persistent Interactive agent
#'
#' @param id Unique execution identifier within this R process.
#' @param code R code to evaluate in the global environment.
#' @param source Optional source-location metadata.
#' @keywords internal
interactive_execute <- function(id, code, source = NULL) {
  .sess_env$interactive_skip_task <- TRUE
  if (!isTRUE(.sess_env$interactive_connected)) stop("No Interactive agent connected")
  if (!is.null(.sess_env$interactive_id)) stop("R is already executing an Interactive request")
  if (!is.character(id) || length(id) != 1L || !grepl("^[a-zA-Z0-9_-]{1,100}$", id)) {
    stop("Invalid execution identifier")
  }
  if (exists(id, envir = .sess_env$interactive_seen, inherits = FALSE)) {
    stop("Execution identifier already evaluated; query the agent for its result")
  }
  assign(id, TRUE, envir = .sess_env$interactive_seen)
  .sess_env$interactive_id <- id
  .sess_env$interactive_plot_groups <- integer()
  on.exit({
    # Live full-table viewers must discard cached filter/sort indices after code
    # may have edited their data by reference (including failed executions).
    .sess_env$dataview_revision <- (.sess_env$dataview_revision %||% 0) + 1
    .sess_env$interactive_id <- NULL
    .interactive_plot_context()
  }, add = TRUE)
  state <- "success"
  trace_state <- new.env(parent = emptyenv())
  trace_state$depth <- 0L
  diagnostic <- function(cnd, kind) {
    # Keep calls made by the submitted expression, not the worker, arf transport,
    # evaluation wrappers, or the condition handlers themselves.
    calls <- sys.calls()
    frames <- seq_along(calls)
    frames <- frames[frames > trace_state$depth]
    # R includes two frames for our eval call, one without a function identity.
    # Match only this exact leading wrapper, not user functions named `eval`.
    wrapper <- quote(withVisible(eval(expr, envir = .GlobalEnv)))
    if (length(frames) >= 3L && identical(calls[[frames[[1L]]]], wrapper)) {
      frames <- frames[-seq_len(3L)]
    }
    handlers <- list(on_error, on_warning, on_message, diagnostic,
                     base::.handleSimpleError, base::.signalSimpleWarning,
                     base::signalCondition)
    internal <- vapply(frames, function(frame) {
      any(vapply(handlers, function(fun) identical(sys.function(frame), fun), FALSE))
    }, FALSE)
    if (any(internal)) frames <- frames[seq_len(which(internal)[[1L]] - 1L)]
    trace <- as.list(vapply(calls[frames], function(x) paste(deparse(x), collapse = " "), ""))
    .interactive_event("condition", list(kind = kind, message = conditionMessage(cnd),
                                         call = paste(deparse(conditionCall(cnd)), collapse = "\n"),
                                         trace = trace))
  }
  on_warning <- function(cnd) {
    if (getOption("warn") >= 2) return()
    if (getOption("warn") >= 0) diagnostic(cnd, "warning")
    invokeRestart("muffleWarning")
  }
  on_message <- function(cnd) {
    diagnostic(cnd, "message")
    invokeRestart("muffleMessage")
  }
  on_error <- function(cnd) diagnostic(cnd, "error")
  evaluate <- function() {
    # The agent can interrupt as soon as started arrives. Install the condition
    # handlers before publishing it or doing any interruptible setup work.
    .interactive_event("started")
    .interactive_plot_context()
    trace_state$depth <- sys.nframe()
    filename <- if (is.null(source$uri)) "<R Interactive>" else source$uri
    text <- strsplit(code, "\n", fixed = TRUE)[[1L]]
    expressions <- parse(text = code, srcfile = srcfilecopy(filename, text), keep.source = TRUE)
    for (expr in expressions) {
      .interactive_plot_context()
      value <- withVisible(eval(expr, envir = .GlobalEnv))
      assign(".Last.value", value$value, envir = .GlobalEnv)
      if (value$visible) {
        # data.table uses an explicit autoprint flag for := and set* operations;
        # withVisible() alone cannot distinguish them from an ordinary result.
        show <- !inherits(value$value, "data.table") || data.table::shouldPrint(value$value)
        if (show && !.interactive_rich_value(value$value)) print(value$value)
      }
      .interactive_capture_plot()
    }
  }
  tryCatch(
    withCallingHandlers(evaluate(),
                        warning = on_warning, message = on_message, error = on_error),
    error = function(cnd) {
      state <<- "error"
    },
    interrupt = function(cnd) {
      state <<- "interrupted"
    }
  )
  .interactive_capture_plot()
  .interactive_event("finished", list(state = state))
  invisible(NULL)
}

.interactive_capture_plot <- function() {
  if (!isTRUE(.sess_env$interactive_static) ||
        isTRUE(.sess_env$interactive_capturing) ||
        grDevices::dev.cur() != getOption("sess.null_dev", -1L)) return()
  .sess_env$interactive_capturing <- TRUE
  on.exit({
    .sess_env$interactive_capturing <- FALSE
  }, add = TRUE)
  record <- tryCatch(grDevices::recordPlot(), error = function(e) NULL)
  if (is.null(record)) return()
  commands <- as.list(record[[1L]])
  # Trailing par()/layout() calls configure future drawing; they do not paint this page.
  # Comparing the whole record also compares graphics state changed by par().
  while (length(commands)) {
    routine <- commands[[length(commands)]][[2L]][[1L]]
    if (!is.list(routine) || !routine$name %in% c("C_par", "C_layout")) break
    commands <- head(commands, -1L)
  }
  if (!length(commands) || identical(commands, .sess_env$interactive_last_plot)) return()
  .sess_env$interactive_last_plot <- commands
  .sess_env$latest_plot_record <- record
  plot <- handle_plot_latest(list(width = 800L, height = 600L, format = "svglite"))
  if (!is.null(plot$data)) {
    page <- .sess_env$interactive_plot_page
    # par() can change the display list without changing the rendered picture.
    if (identical(page, .sess_env$interactive_last_plot_page) &&
          identical(plot$data, .sess_env$interactive_last_plot_data)) return()
    .sess_env$interactive_last_plot_page <- page
    .sess_env$interactive_last_plot_data <- plot$data
    mime <- if (identical(plot$format, "png")) "image/png" else "image/svg+xml"
    .interactive_event("display", list(kind = "image", data = plot$data,
                                       mime = mime,
                                       displayId = paste("static", .sess_env$interactive_id,
                                                         page, sep = "-")))
  }
}

.interactive_table_text <- function(value) {
  file <- tempfile("table-print-")
  on.exit(unlink(file))
  tryCatch({
    # Use the class printer and current R options. A file bounds the amount we
    # retain in memory even when a custom printer produces a very large table.
    # Binary output keeps notebook newlines portable on Windows too.
    connection <- file(file, open = "wb")
    tryCatch(utils::capture.output(print(value), file = connection),
             finally = close(connection))
    limit <- 256L * 1024L
    text <- readChar(file, nchars = limit, useBytes = TRUE)
    if (!length(text)) text <- ""
    text <- iconv(text, to = "UTF-8", sub = "")
    if (file.info(file)$size > limit) {
      text <- paste0(text, "\n[Printed preview truncated at 256 KiB]\n")
    }
    list(printedText = text)
  }, error = function(e) list(printError = conditionMessage(e)))
}

.interactive_table_snapshot <- function(value) {
  source_rows <- nrow(value)
  # Bound work before copying or invoking a class printer. Bounding the printed
  # bytes afterwards does not prevent a printer from scanning billions of rows.
  limit <- max(1L, min(1000L, floor(100000 / max(1L, ncol(value)))))
  truncated <- source_rows > limit
  # Row subsetting already allocates independent data.table columns. Calling
  # copy() afterwards also duplicates attributes and objects inside list cells.
  snapshot <- dataview_slice(value, seq_len(min(source_rows, limit)))
  if (is.data.frame(snapshot)) {
    for (position in seq_len(ncol(snapshot))) {
      column <- snapshot[[position]]
      if (is.list(column) && is.null(dim(column)) && !inherits(column, "POSIXlt")) {
        snapshot[[position]] <- lapply(column, dataview_cell_preview)
      } else if (is.character(column)) {
        snapshot[[position]] <- dataview_preview_text(column)
      }
    }
  } else if (is.character(snapshot)) {
    snapshot[] <- dataview_preview_text(snapshot)
  }
  list(value = snapshot, source_rows = source_rows, truncated = truncated)
}

.interactive_rich_value <- function(value) {
  if (dataview_is_table(value)) {
    snapshot <- .interactive_table_snapshot(value)
    registration <- dataview_register(snapshot$value)
    metadata <- handle_dataview_init(list(view_id = registration$view_id))
    preview <- handle_dataview_page(list(view_id = registration$view_id,
                                         startRow = 0L, endRow = 20L,
                                         formatNumbers = TRUE,
                                         sortModel = list(), filterModel = list()))
    printed <- .interactive_table_text(snapshot$value)
    full_view <- NULL
    if (snapshot$truncated) {
      # Retain the full object without copying it. The cell remains a snapshot;
      # the expanded viewer can reflect later reference edits to this object.
      full_view <- dataview_register(value, live = TRUE)$view_id
      if (!is.null(printed$printedText)) {
        note <-
          sprintf("\n[Snapshot: first %s of %s rows. Open Data viewer for the full table.]\n",
                  format(metadata$totalRows, big.mark = ",", scientific = FALSE, trim = TRUE),
                  format(snapshot$source_rows, big.mark = ",", scientific = FALSE, trim = TRUE))
        printed$printedText <- paste0(printed$printedText, note)
      }
    }
    .interactive_event("display", c(list(kind = "table", viewId = registration$view_id,
                                         fullViewId = full_view,
                                         sourceRows = snapshot$source_rows,
                                         columns = metadata$columns, rows = preview$rows,
                                         formattedColumns = preview$formattedColumns,
                                         totalRows = metadata$totalRows),
                                    printed))
    return(TRUE)
  }
  if (is.list(value) && !is.object(value)) {
    view_id <- dataview_new_id()
    root <- listview_state(value, "List", "List")
    dataview_set_state(view_id, root)
    preview <- get_workspace_children(view_id = view_id)
    .interactive_event("display", c(list(kind = "list", viewId = view_id,
                                         navigation = listview_navigation(listview_location(root))),
                                    preview, .interactive_table_text(value)))
    return(TRUE)
  }
  if (inherits(value, "htmlwidget") && requireNamespace("htmlwidgets", quietly = TRUE)) {
    directory <- tempfile("widget-")
    dir.create(directory)
    file <- file.path(directory, "index.html")
    htmlwidgets::saveWidget(value, file, selfcontained = FALSE)
    .interactive_event("display", list(kind = "html", file = file))
    return(TRUE)
  }
  if (inherits(value, c("shiny.tag", "shiny.tag.list", "html")) &&
        requireNamespace("htmltools", quietly = TRUE)) {
    directory <- tempfile("html-")
    dir.create(directory)
    file <- file.path(directory, "index.html")
    htmltools::save_html(value, file)
    .interactive_event("display", list(kind = "html", file = file))
    return(TRUE)
  }
  FALSE
}

#' Publish a rich Interactive output
#'
#' @param x Object to display, or text for an explicit MIME type.
#' @param mime Optional MIME type, such as text/markdown or text/html.
#' @export
display <- function(x, mime = NULL) {
  if (!isTRUE(.sess_env$interactive_connected)) {
    print(x)
  } else if (!is.null(mime)) {
    .interactive_event("display", list(kind = "mime", mime = mime,
                                       text = paste(as.character(x), collapse = "\n")))
  } else if (!.interactive_rich_value(x)) {
    print(x)
  }
  invisible(x)
}

#' Disconnect the persistent Interactive bridge without terminating R
#'
#' Restores sess runtime hooks without changing the frontend console callbacks.
#' @export
interactive_stop <- function() {
  .sess_env$interactive_stop <- TRUE
  if (!is.null(.sess_env$interactive_task)) {
    removeTaskCallback(.sess_env$interactive_task)
    .sess_env$interactive_task <- NULL
  }
  .transport_disconnect(silent = TRUE)
  .sess_env$interactive_connected <- FALSE
  .sess_env$interactive_stdout <- NULL
  .sess_env$interactive_stderr <- NULL
  .sess_env$interactive_id <- NULL
  invisible(NULL)
}
