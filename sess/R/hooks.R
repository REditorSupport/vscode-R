dataview_data_type <- function(x) {
  if (is.numeric(x)) {
    if (is.null(attr(x, "class"))) {
      "num"
    } else {
      "num-fmt"
    }
  } else if (inherits(x, "Date")) {
    "date"
  } else {
    "string"
  }
}

dataview_table <- function(data) {
  if (is.data.frame(data)) {
    nrow <- nrow(data)
    colnames <- colnames(data)
    if (is.null(colnames)) {
      colnames <- sprintf("(X%d)", seq_len(ncol(data)))
    } else {
      colnames <- trimws(colnames)
    }
    if (.row_names_info(data) > 0L) {
      rownames <- rownames(data)
      rownames(data) <- NULL
    } else {
      rownames <- seq_len(nrow)
    }
    data <- c(list(" " = rownames), .subset(data))
    colnames <- c(" ", colnames)
    types <- vapply(data, dataview_data_type,
      character(1L),
      USE.NAMES = FALSE
    )
    data <- vapply(data, function(x) {
      trimws(format(x))
    }, character(nrow), USE.NAMES = FALSE)
    dim(data) <- c(length(rownames), length(colnames))
  } else if (is.matrix(data)) {
    if (is.factor(data)) {
      data <- format(data)
    }
    types <- rep(dataview_data_type(data), ncol(data))
    colnames <- colnames(data)
    colnames(data) <- NULL
    if (is.null(colnames)) {
      colnames <- sprintf("(X%d)", seq_len(ncol(data)))
    } else {
      colnames <- trimws(colnames)
    }
    rownames <- rownames(data)
    rownames(data) <- NULL
    data <- trimws(format(data))
    if (is.null(rownames)) {
      types <- c("num", types)
      rownames <- seq_len(nrow(data))
    } else {
      types <- c("string", types)
      rownames <- trimws(rownames)
    }
    dim(data) <- c(length(rownames), length(colnames))
    colnames <- c(" ", colnames)
    data <- cbind(rownames, data)
  } else {
    stop("data must be data.frame or matrix")
  }
  columns <- .mapply(function(title, type, index) {
    class <- if (type == "string") "text-left" else "text-right"
    list(
      headerName = jsonlite::unbox(title),
      field = jsonlite::unbox(as.character(index - 1L)),
      cellClass = jsonlite::unbox(class),
      type = jsonlite::unbox(if (type == "date") "dateColumn" else type)
    )
  }, list(colnames, types, seq_along(colnames)), NULL)
  list(columns = columns, data = data)
}

#' Register hooks for the client IPC
#'
#' @param use_rstudioapi Logical. Enable rstudioapi emulation.
#' @param use_httpgd Logical. Enable httpgd plot device if available.
#' @export
register_hooks <- function(use_rstudioapi = TRUE, use_httpgd = TRUE) {
  # 1. Override View() to push data directly via WebSocket
  show_dataview <- function(x, title = deparse(substitute(x))) {
    # make sure title is computed.
    force(title)
    # Dump to a temporary file locally so the payload size over WS isn't massive
    file_path <- tempfile(tmpdir = .sess_env$tempdir, fileext = ".json")

    row_limit <- abs(getOption("sess.row_limit", 100))

    as_truncated_data <- function(.data) {
      .nrow <- nrow(.data)
      if (row_limit != 0 && row_limit < .nrow) {
        title <<- sprintf("%s (limited to %d/%d)", title, row_limit, .nrow)
        .data <- utils::head(.data, n = row_limit)
      }
      return(.data)
    }

    if (inherits(x, "ArrowTabular")) {
      x <- as_truncated_data(x)
      x <- as.data.frame(x)
    }

    if (is.data.frame(x) || is.matrix(x)) {
      x <- as_truncated_data(x)
      data <- dataview_table(x)
      jsonlite::write_json(
        data, file_path,
        matrix = "rowmajor", auto_unbox = TRUE, null = "null", na = "string"
      )

      notify_client("dataview", list(
        title = title,
        file = file_path,
        source = "table",
        type = "json",
        viewer = getOption("sess.dataview", "Two")
      ))
    } else if (is.list(x)) {
      jsonlite::write_json(x, file_path, auto_unbox = TRUE, null = "null", na = "string")
      notify_client("dataview", list(
        title = title,
        file = file_path,
        source = "list",
        type = "json",
        viewer = getOption("sess.dataview", "Two")
      ))
    } else {
      code <- if (is.primitive(x)) utils::capture.output(print(x)) else deparse(x)
      file_path <- tempfile(tmpdir = .sess_env$tempdir, fileext = ".R")
      writeLines(code, file_path)
      notify_client("dataview", list(
        title = title,
        file = file_path,
        source = "object",
        type = "R",
        viewer = getOption("sess.dataview", "Two")
      ))
    }
  }
  rebind("View", show_dataview, ns = "utils")

  # 2. Browser & Webview Options 
  viewer <- function(url, ...) {
    if (!is.character(url)) {
      real_url <- NULL
      temp_viewer <- function(url, ...) {
        real_url <<- url
      }
      op <- options(viewer = temp_viewer, page_viewer = temp_viewer)
      on.exit(options(op))
      print(url)
      if (is.character(real_url)) {
        url <- real_url
      } else {
        stop("Invalid object")
      }
    }

    url <- sub("^file\\://", "", url)
    if (file.exists(url)) {
      url <- normalizePath(url, "/", mustWork = TRUE)
    }
    notify_client("webview", list(url = url))
  }

  options(
    browser = viewer,
    viewer = viewer,
    page_viewer = viewer,
    help_type = "html"
  )

  # 3. Help System Interception
  sess_print.help_files_with_topic <- function(x, ...) {
    if (length(x) >= 1 && is.character(x)) {
      file <- x[1]
      pkgname <- basename(dirname(dirname(file)))
      requestPath <- paste0("/library/", pkgname, "/html/", basename(file), ".html")
      notify_client("help", list(requestPath = requestPath, viewer = getOption("sess.helpPanel", "Two")))
    } else {
      utils:::print.help_files_with_topic(x, ...)
    }
    invisible(x)
  }
  registerS3method("print", "help_files_with_topic", sess_print.help_files_with_topic, envir = asNamespace("utils"))

  sess_print.hsearch <- function(x, ...) {
    if (length(x) >= 1) {
      requestPath <- paste0("/doc/html/Search?pattern=", tools:::escapeAmpersand(x$pattern))
      notify_client("help", list(requestPath = requestPath, viewer = getOption("sess.helpPanel", "Two")))
    } else {
      utils:::print.hsearch(x, ...)
    }
    invisible(x)
  }

  # 4. httpgd or Static Plot Hook
  if (use_httpgd && requireNamespace("httpgd", quietly = TRUE)) {
    options(device = function(...) {
      httpgd::hgd(silent = TRUE)
      notify_client("httpgd", list(url = httpgd::hgd_url()))
    })
  } else {
    # Default to static plot capturing
    options(device = function(...) {
      png(.sess_env$latest_plot_path, width = 800, height = 600, res = 72)
    })

    setHook("plot.new", function(...) {
      notify_client("plot_updated")
    }, "replace")

    setHook("grid.newpage", function(...) {
      notify_client("plot_updated")
    }, "replace")
  }

  # 5. rstudioapi hooks
  if (use_rstudioapi) {
    setHook(packageEvent("rstudioapi", "onLoad"), function(...) {
      patch_rstudioapi()
    }, action = "append")

    if ("rstudioapi" %in% loadedNamespaces()) {
      patch_rstudioapi()
    }
  }

  # 6. Workspace Update Callback
  # This notifies the client whenever a top-level command is completed,
  # suggesting that the Global Environment might have changed.
  removeTaskCallback("sess.workspace")
  addTaskCallback(function(...) {
    notify_client("workspace_updated")
    TRUE
  }, name = "sess.workspace")

  invisible(NULL)
}
