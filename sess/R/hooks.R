#' Register hooks for the client IPC
#'
#' @param use_rstudioapi Logical. Enable rstudioapi emulation.
#' @param use_httpgd Logical. Enable httpgd plot device if available.
#' @param use_jgd Logical. Enable jgd plot device if available.
#' @export
register_hooks <- function(use_rstudioapi = TRUE, use_httpgd = TRUE, use_jgd = FALSE) {
  # 1. Override View() to serve table data via paged RPC.
  show_dataview <- function(x, title = deparse(substitute(x))) {
    # make sure title is computed.
    force(title)

    if (inherits(x, "ArrowTabular")) {
      x <- as.data.frame(x)
    }

    if (is.data.frame(x) || is.matrix(x)) {
      registration <- dataview_register(x)

      notify_client("dataview", list(
        title = title,
        source = "table",
        type = "json",
        view_id = registration$view_id,
        total_rows = registration$total_rows
      ))
    } else if (is.list(x)) {
      file_path <- tempfile(tmpdir = .sess_env$tempdir, fileext = ".json")
      jsonlite::write_json(x, file_path, auto_unbox = TRUE, null = "null", na = "string")
      notify_client("dataview", list(
        title = title,
        file = file_path,
        source = "list",
        type = "json"
      ))
    } else {
      code <- if (is.primitive(x)) utils::capture.output(print(x)) else deparse(x)
      file_path <- tempfile(tmpdir = .sess_env$tempdir, fileext = ".R")
      writeLines(code, file_path)
      notify_client("dataview", list(
        title = title,
        file = file_path,
        source = "object",
        type = "R"
      ))
    }
  }
  rebind("View", show_dataview, ns = "utils")

  # 2. Browser & Webview Options
  make_viewer <- function(method) {
    function(url, ...) {
      if (!is.character(url)) {
        real_url <- NULL
        temp_viewer <- function(url, ...) {
          real_url <<- url
        }
        op <- options(viewer = temp_viewer, page_viewer = temp_viewer, browser = temp_viewer)
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
      notify_client(method, list(url = url))
    }
  }

  options(
    browser = make_viewer("browser"),
    viewer = make_viewer("webview"),
    page_viewer = make_viewer("page_viewer"),
    help_type = "html"
  )

  # 3. Help System Interception
  sess_print.help_files_with_topic <- function(x, ...) {
    if (length(x) >= 1 && is.character(x)) {
      file <- x[1]
      pkgname <- basename(dirname(dirname(file)))
      requestPath <- paste0("/library/", pkgname, "/html/", basename(file), ".html")
      notify_client("help", list(
        requestPath = requestPath,
        viewer = getOption("sess.helpPanel", "Two")
      ))
    } else {
      utils:::print.help_files_with_topic(x, ...)
    }
    invisible(x)
  }
  registerS3method(
    "print", "help_files_with_topic", sess_print.help_files_with_topic,
    envir = asNamespace("utils")
  )

  sess_print.hsearch <- function(x, ...) {
    if (length(x) >= 1) {
      requestPath <- paste0("/doc/html/Search?pattern=", tools:::escapeAmpersand(x$pattern))
      notify_client("help", list(
        requestPath = requestPath,
        viewer = getOption("sess.helpPanel", "Two")
      ))
    } else {
      utils:::print.hsearch(x, ...)
    }
    invisible(x)
  }

  # 4. Plot device: JGD > httpgd > Standard
  if (use_jgd && nzchar(Sys.getenv("JGD_SOCKET")) && requireNamespace("jgd", quietly = TRUE)) {
    options(device = function(...) {
      jgd::jgd()
    })

    # On reattach (e.g. after a VS Code window reload) the renderer starts a new
    # socket, but any jgd device opened before the reload is still bound to the
    # old, now-dead socket. jgd::jgd() only reads JGD_SOCKET at device-creation
    # time, so the stale device never reconnects and plots silently go nowhere.
    # Reopen it against the new socket, replaying the current plot if possible.
    reconnect_jgd_device <- function() {
      devs <- grDevices::dev.list()
      if (is.null(devs) || !"jgd" %in% names(devs)) {
        return(invisible(FALSE))
      }
      grDevices::dev.set(devs[names(devs) == "jgd"][[1]])
      recorded <- tryCatch(grDevices::recordPlot(), error = function(e) NULL)
      tryCatch(grDevices::dev.off(), error = function(e) NULL)
      tryCatch(jgd::jgd(), error = function(e) NULL)
      if (!is.null(recorded)) {
        tryCatch(grDevices::replayPlot(recorded), error = function(e) NULL)
      }
      invisible(TRUE)
    }
    reconnect_jgd_device()
  } else if (use_httpgd && requireNamespace("httpgd", quietly = TRUE)) {
    options(device = function(...) {
      httpgd::hgd(silent = TRUE)
      notify_client("httpgd", list(url = httpgd::hgd_url()))
    })
  } else {
    # Default to static plot capturing (Re-implementation based on legacy plot handler)
    plot_file <- .sess_env$latest_plot_path
    file.create(plot_file, showWarnings = FALSE)

    plot_updated <- FALSE
    last_plot_record_length <- 0

    check_null_dev <- function() {
      cur <- grDevices::dev.cur()
      id <- getOption("sess.null_dev")
      !is.null(id) && cur == id
    }

    new_plot <- function() {
      if (check_null_dev()) {
        plot_updated <<- TRUE
      }
    }

    options(device = function(...) {
      grDevices::pdf(NULL, width = 7, height = 7, bg = "white")
      options(sess.null_dev = grDevices::dev.cur())
      grDevices::dev.control(displaylist = "enable")
    })

    update_plot <- function(...) {
      tryCatch(
        {
          if (check_null_dev()) {
            # Only record if we are reasonably sure there is something to record
            # and we are on the null device.
            record <- grDevices::recordPlot()
            if (length(record[[1L]])) {
              curr_length <- length(record[[1L]])
              if (plot_updated || curr_length != last_plot_record_length) {
                plot_updated <<- FALSE
                last_plot_record_length <<- curr_length
                .sess_env$latest_plot_record <- record
                notify_client("plot_updated")
              }
            }
          }
        },
        error = function(e) {
          warning("Error in sess update_plot: ", e$message)
        }
      )
      TRUE
    }

    setHook("plot.new", new_plot, "replace")
    setHook("grid.newpage", new_plot, "replace")

    update_plot()
    addTaskCallback(update_plot, name = "sess.plot")
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
