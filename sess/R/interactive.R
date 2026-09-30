# Native console events use one ordered channel, independent of the editor socket.
.interactive_event <- function(type, data = list()) {
  id <- .sess_env$interactive_id
  event <- c(list(type = type, executionId = if (is.null(id)) "" else id), data)
  .Call("sess_bridge_send", as.character(jsonlite::toJSON(
    event, auto_unbox = TRUE, null = "null", na = "null", digits = NA
  )), PACKAGE = "sess")
  invisible(NULL)
}

.interactive_plot_context <- function() {
  if (requireNamespace("jgd", quietly = TRUE) &&
        "jgd" %in% names(grDevices::dev.list())) {
    id <- .sess_env$interactive_id
    context <- as.character(jsonlite::toJSON(
      list(executionId = if (is.null(id)) "" else id,
           vscodeRExecutionId = if (is.null(id)) "" else id), auto_unbox = TRUE
    ))
    try(jgd::jgd_frame_ext(context), silent = TRUE)
    if (!is.null(id)) {
      device <- as.integer(grDevices::dev.cur())
      if (!device %in% .sess_env$interactive_plot_groups) {
        try(jgd::jgd_begin_group(context), silent = TRUE)
        .sess_env$interactive_plot_groups <- c(.sess_env$interactive_plot_groups, device)
      }
    } else {
      selected <- grDevices::dev.cur()
      for (device in intersect(.sess_env$interactive_plot_groups, grDevices::dev.list())) {
        grDevices::dev.set(device)
        try(jgd::jgd_end_group(), silent = TRUE)
      }
      if (selected %in% grDevices::dev.list()) grDevices::dev.set(selected)
      .sess_env$interactive_plot_groups <- integer()
    }
  }
}

#' Connect an existing R frontend to a persistent Interactive agent
#'
#' @param config Path to the private JSON bootstrap configuration created by the agent.
#' @param mirror Whether to also write console output to the original frontend.
#' @export
interactive_start <- function(config, mirror = TRUE) {
  if (isTRUE(.sess_env$interactive_connected)) {
    stop("This R process already belongs to an Interactive agent")
  }
  cfg <- jsonlite::read_json(config, simplifyVector = TRUE)
  if (!interactive()) stop("The Interactive worker requires an interactive R frontend")
  options(sess.quiet = TRUE)
  .sess_env$interactive_token <- cfg$token
  Sys.setenv(JGD_SOCKET = cfg$jgd, SESS_ENDPOINT = cfg$sess)
  connect(endpoint = cfg$sess, use_httpgd = FALSE, use_jgd = isTRUE(cfg$useJgd))
  if (is.null(.sess_env$con)) stop("Could not connect to the session agent")
  .Call("sess_bridge_start", cfg$console, cfg$token, mirror, PACKAGE = "sess")
  .sess_env$interactive_connected <- TRUE
  .sess_env$interactive_id <- NULL
  .sess_env$interactive_plot_groups <- integer()
  .sess_env$interactive_queue <- list()
  .sess_env$interactive_seen <- new.env(parent = emptyenv())
  .sess_env$interactive_stop <- FALSE
  .sess_env$interactive_worker <- !mirror
  .sess_env$interactive_static <- !isTRUE(cfg$useJgd)
  .sess_env$interactive_last_plot <- NULL
  if (isTRUE(cfg$useJgd)) {
    select_device <- grDevices::dev.set
    .runtime_rebind("dev.set", function(which = grDevices::dev.next()) {
      result <- select_device(which)
      if (!is.null(.sess_env$interactive_id)) .interactive_plot_context()
      invisible(result)
    }, ns = "grDevices")
  }
  if (isTRUE(.sess_env$interactive_static)) {
    for (spec in list(c("graphics", "plot.new"), c("grid", "grid.newpage"))) {
      original <- get(spec[[2L]], envir = asNamespace(spec[[1L]]))
      wrapped <- local({
        draw <- original
        function(...) {
          .interactive_capture_plot()
          draw(...)
        }
      })
      .runtime_rebind(spec[[2L]], wrapped, ns = spec[[1L]])
    }
  }
  device <- getOption("device")
  if (is.function(device)) {
    options(device = local({
      original <- device
      function(...) {
        original(...)
        .interactive_plot_context()
      }
    }))
  }
  if (mirror) {
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
                                   sessionId = .session_id(), nativeConsole = TRUE))
  invisible(NULL)
}

#' Run the managed Interactive worker
#'
#' @param config Path to the agent's private bootstrap configuration.
#' @export
run_worker <- function(config) {
  interactive_start(config, mirror = FALSE)
  on.exit(.Call("sess_bridge_stop", PACKAGE = "sess"), add = TRUE)
  while (!isTRUE(.sess_env$interactive_stop)) {
    tryCatch({
      later::run_now(0.05)
      queue <- .sess_env$interactive_queue
      if (length(queue)) {
        request <- queue[[1L]]
        .sess_env$interactive_queue <- queue[-1L]
        interactive_execute(request$id, request$code, request$source)
      }
    }, interrupt = function(e) NULL)
  }
  invisible(NULL)
}

#' Evaluate an execution admitted by a persistent Interactive agent
#'
#' @param id Unique execution identifier within this R process.
#' @param code R code to evaluate in the global environment.
#' @param source Optional source-location metadata.
#' @export
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
  .Call("sess_bridge_context", id, PACKAGE = "sess")
  on.exit({
    .sess_env$interactive_id <- NULL
    .interactive_plot_context()
    .Call("sess_bridge_context", "", PACKAGE = "sess")
  }, add = TRUE)
  .interactive_event("started")
  .interactive_plot_context()
  state <- "success"
  diagnostic <- function(cnd, kind) {
    trace <- as.list(vapply(sys.calls(), function(x) paste(deparse(x), collapse = " "), ""))
    .interactive_event("condition", list(kind = kind, message = conditionMessage(cnd),
                                         call = paste(deparse(conditionCall(cnd)), collapse = "\n"),
                                         trace = trace))
  }
  tryCatch(withCallingHandlers({
    filename <- if (is.null(source$uri)) "<R Interactive>" else source$uri
    text <- strsplit(code, "\n", fixed = TRUE)[[1L]]
    expressions <- parse(text = code, srcfile = srcfilecopy(filename, text), keep.source = TRUE)
    for (expr in expressions) {
      .interactive_plot_context()
      value <- withVisible(eval(expr, envir = .GlobalEnv))
      assign(".Last.value", value$value, envir = .GlobalEnv)
      if (value$visible) {
        if (!.interactive_rich_value(value$value)) print(value$value)
      }
      .interactive_capture_plot()
    }
  }, warning = function(cnd) {
    if (getOption("warn") >= 2) return()
    diagnostic(cnd, "warning")
    invokeRestart("muffleWarning")
  }, message = function(cnd) {
    diagnostic(cnd, "message")
    invokeRestart("muffleMessage")
  }, error = function(cnd) diagnostic(cnd, "error")),
  error = function(cnd) {
    state <<- "error"
  },
  interrupt = function(cnd) {
    state <<- "interrupted"
  })
  .interactive_capture_plot()
  .interactive_event("finished", list(state = state))
  invisible(NULL)
}

.interactive_capture_plot <- function() {
  if (!isTRUE(.sess_env$interactive_static) ||
        isTRUE(.sess_env$interactive_capturing) || grDevices::dev.cur() == 1L) return()
  .sess_env$interactive_capturing <- TRUE
  on.exit({
    .sess_env$interactive_capturing <- FALSE
  }, add = TRUE)
  record <- tryCatch(grDevices::recordPlot(), error = function(e) NULL)
  if (is.null(record) || !length(record[[1L]]) ||
        identical(record, .sess_env$interactive_last_plot)) return()
  .sess_env$interactive_last_plot <- record
  .sess_env$latest_plot_record <- record
  plot <- handle_plot_latest(list(width = 800L, height = 600L, format = "svglite"))
  if (!is.null(plot$data)) {
    mime <- if (identical(plot$format, "png")) "image/png" else "image/svg+xml"
    .interactive_event("display", list(kind = "image", data = plot$data,
                                       mime = mime))
  }
}

.interactive_rich_value <- function(value) {
  if (dataview_is_table(value)) {
    registration <- dataview_register(value)
    metadata <- handle_dataview_init(list(view_id = registration$view_id))
    preview <- handle_dataview_page(list(view_id = registration$view_id,
                                         startRow = 0L, endRow = 20L,
                                         sortModel = list(), filterModel = list()))
    .interactive_event("display", list(kind = "table", viewId = registration$view_id,
                                       columns = metadata$columns, rows = preview$rows,
                                       totalRows = metadata$totalRows))
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
#' Restores the original frontend console callbacks and sess runtime hooks.
#' @export
interactive_stop <- function() {
  .sess_env$interactive_stop <- TRUE
  if (!is.null(.sess_env$interactive_task)) {
    removeTaskCallback(.sess_env$interactive_task)
    .sess_env$interactive_task <- NULL
  }
  .Call("sess_bridge_stop", PACKAGE = "sess")
  .transport_disconnect(silent = TRUE)
  .sess_env$interactive_connected <- FALSE
  .sess_env$interactive_id <- NULL
  invisible(NULL)
}
