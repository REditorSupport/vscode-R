#' Register VS Code runtime integrations
#'
#' @param use_rstudioapi Logical. Enable rstudioapi emulation.
#' @param use_httpgd Logical. Enable httpgd plot device if available.
#' @param use_jgd Logical. Enable jgd plot device if available.
#' @export
register_hooks <- function(use_rstudioapi = TRUE, use_httpgd = TRUE, use_jgd = FALSE) {
  runtime_start(use_rstudioapi, use_httpgd, use_jgd)
}

#' Start the VS Code runtime integration (internal)
#'
#' @keywords internal
runtime_start <- function(use_rstudioapi = TRUE, use_httpgd = TRUE, use_jgd = FALSE) {
  state <- .runtime_state()
  if (isTRUE(state$active)) runtime_stop()
  state <- .runtime_state()
  state$active <- TRUE
  completed <- FALSE
  on.exit(if (!completed) try(runtime_stop(), silent = TRUE), add = TRUE)

  # 1. Override View() to serve table data via paged RPC.
  if (is.null(.sess_env$dataview_registry)) {
    .runtime_set_field("dataview_registry", new.env(parent = emptyenv()))
  }

  show_dataview <- function(x, title = deparse(substitute(x))) {
    # make sure title is computed.
    force(title)

    if (dataview_is_table(x)) {
      title_key <- paste(as.character(title), collapse = "\n")
      dataview_registry <- .sess_env$dataview_registry
      has_view_id <- nzchar(title_key) &&
        exists(title_key, envir = dataview_registry, inherits = FALSE)
      view_id <- if (has_view_id) {
        get(title_key, envir = dataview_registry, inherits = FALSE)
      } else {
        id <- dataview_new_id()
        if (nzchar(title_key)) {
          assign(title_key, id, envir = dataview_registry)
        }
        id
      }

      registration <- dataview_register(x, view_id = view_id)

      notify_client("dataview", list(
        title = title,
        source = "table",
        type = "json",
        view_id = registration$view_id
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
  .runtime_rebind("View", show_dataview, ns = "utils")

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

  .runtime_set_option("browser", make_viewer("browser"))
  .runtime_set_option("viewer", make_viewer("webview"))
  .runtime_set_option("page_viewer", make_viewer("page_viewer"))
  .runtime_set_option("help_type", "html")

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
  .runtime_register_s3(
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
    .runtime_set_option("device", function(...) {
      jgd::jgd()
      .runtime_track_device()
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
      before_reopen <- grDevices::dev.list()
      tryCatch(jgd::jgd(), error = function(e) NULL)
      after_reopen <- grDevices::dev.list()
      if (!is.null(after_reopen)) {
        opened <- if (is.null(before_reopen)) after_reopen else setdiff(after_reopen, before_reopen)
        if (length(opened)) .runtime_track_device(opened[[1L]])
      }
      if (!is.null(recorded)) {
        tryCatch(grDevices::replayPlot(recorded), error = function(e) NULL)
      }
      invisible(TRUE)
    }
    reconnect_jgd_device()
  } else if (use_httpgd && requireNamespace("httpgd", quietly = TRUE)) {
    .runtime_set_option("device", function(...) {
      httpgd::hgd(silent = TRUE)
      .runtime_track_device()
      notify_client("httpgd", list(url = httpgd::hgd_url()))
    })
  } else {
    # If a specific interactive backend was explicitly requested but is
    # unavailable, warn before silently degrading to the standard viewer.
    # (use_jgd && use_httpgd means "auto", which is meant to degrade quietly.)
    if (xor(use_jgd, use_httpgd)) {
      if (use_jgd && !requireNamespace("jgd", quietly = TRUE)) {
        warning("[sess] Plot backend \"jgd\" was requested but the jgd package ",
                "is not installed. Falling back to the standard plot viewer. ",
                "Install jgd, or change the r.plot.backend setting.", call. = FALSE)
      } else if (use_jgd) {
        warning("[sess] Plot backend \"jgd\" was requested but no renderer ",
                "connection is available. Falling back to the standard plot ",
                "viewer.", call. = FALSE)
      } else if (use_httpgd) {
        warning("[sess] Plot backend \"httpgd\" was requested but the httpgd ",
                "package is not installed. Falling back to the standard plot ",
                "viewer. Install httpgd, or change the r.plot.backend setting.",
                call. = FALSE)
      }
    }

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

    .runtime_set_option("device", function(...) {
      grDevices::pdf(NULL, width = 7, height = 7, bg = "white")
      .runtime_track_device()
      .runtime_set_option("sess.null_dev", grDevices::dev.cur())
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
                .runtime_set_field("latest_plot_record", record)
                sent <- notify_client("plot_updated")
                # Temporary CI diagnostic; remove after poll/callback cause is known.
                message("[sess diagnostic] plot_updated notify sent=", isTRUE(sent))
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

    .runtime_set_hook("plot.new", new_plot, "replace")
    .runtime_set_hook("grid.newpage", new_plot, "replace")

    update_plot()
    .runtime_add_task_callback(function(...) {
      # Temporary CI diagnostic; remove after poll/callback cause is known.
      message("[sess diagnostic] entered sess.plot task callback; active=",
              isTRUE(.runtime_state()$active))
      update_plot(...)
    }, name = "sess.plot")
  }

  # 5. rstudioapi hooks
  if (use_rstudioapi) {
    rstudioapi_hook <- function(...) {
      patch_rstudioapi()
    }
    .runtime_set_hook(packageEvent("rstudioapi", "onLoad"),
                      rstudioapi_hook, action = "append")

    if ("rstudioapi" %in% loadedNamespaces()) {
      patch_rstudioapi()
    }
  }

  # 6. Workspace Update Callback
  # This notifies the client whenever a top-level command is completed,
  # suggesting that the Global Environment might have changed.
  .runtime_add_task_callback(function(...) {
    # Temporary CI diagnostic; remove after poll/callback cause is known.
    message("[sess diagnostic] entered sess.workspace task callback; active=",
            isTRUE(.runtime_state()$active))
    if (!isTRUE(.runtime_state()$active)) return(FALSE)
    sent <- notify_client("workspace_updated")
    message("[sess diagnostic] workspace_updated notify sent=", isTRUE(sent))
    TRUE
  }, name = "sess.workspace")

  completed <- TRUE
  invisible(NULL)
}
