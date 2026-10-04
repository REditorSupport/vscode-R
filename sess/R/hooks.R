#' Register VS Code runtime integrations
#'
#' @param use_rstudioapi Logical. Enable rstudioapi emulation.
#' @param use_httpgd Deprecated. Logical. Enable httpgd plot device if available.
#'   NULL means unspecified; legacy calls default to TRUE. Use `plot_backend` instead.
#' @param use_jgd Deprecated. Logical. Enable jgd plot device if available.
#'   NULL means unspecified; legacy calls default to FALSE. Use `plot_backend` instead.
#' @param plot_backend Plot backend: `auto`, `jgd`, `httpgd`, `standard`, or
#'   `native`. NULL also selects `auto`. Deprecated flags select the backend
#'   only when this argument is omitted.
#' @export
register_hooks <- function(use_rstudioapi = TRUE, use_httpgd = NULL, use_jgd = NULL,
                           plot_backend = c("auto", "jgd", "httpgd", "standard", "native")) {
  has_httpgd <- !is.null(use_httpgd)
  has_jgd <- !is.null(use_jgd)
  .warn_deprecated_plot_args(has_httpgd, has_jgd)
  backend <- if (missing(plot_backend) && (has_httpgd || has_jgd)) {
    .legacy_plot_backend(use_httpgd, use_jgd)
  } else {
    .resolve_plot_backend(plot_backend)
  }
  runtime_start(use_rstudioapi, backend)
}

.warn_deprecated_plot_args <- function(has_httpgd, has_jgd) {
  old_args <- c(if (has_httpgd) "use_httpgd", if (has_jgd) "use_jgd")
  if (length(old_args)) {
    warning("[sess] ", paste(old_args, collapse = " and "),
            if (length(old_args) == 1L) " is deprecated; use plot_backend instead." else
              " are deprecated; use plot_backend instead.", call. = FALSE)
  }
  invisible(NULL)
}

.resolve_plot_backend <- function(plot_backend) {
  if (is.null(plot_backend)) return("auto")
  match.arg(plot_backend, c("auto", "jgd", "httpgd", "standard", "native"))
}

.legacy_plot_backend <- function(use_httpgd, use_jgd) {
  if (is.null(use_httpgd) || is.na(use_httpgd)) use_httpgd <- TRUE
  if (is.null(use_jgd) || is.na(use_jgd)) use_jgd <- FALSE
  if (use_jgd && use_httpgd) "auto" else if (use_jgd) "jgd" else
    if (use_httpgd) "httpgd" else "standard"
}

.select_plot_backend <- function(plot_backend, has_httpgd, has_jgd) {
  if (plot_backend == "native") return("native")
  if (plot_backend %in% c("auto", "jgd") && has_jgd) return("jgd")
  if (plot_backend %in% c("auto", "httpgd") && has_httpgd) return("httpgd")
  "standard"
}

# Send runtime notifications after task callbacks return, so transport failure
# cannot remove the currently executing task callback during runtime cleanup.
.defer_runtime_notification <- function(method, schedule = later::later) {
  if (!isTRUE(.runtime_state()$active)) return(FALSE)
  force(method)
  generation <- .sess_env$transport_generation
  schedule(function() {
    if (!isTRUE(.runtime_state()$active) ||
          !identical(generation, .sess_env$transport_generation)) {
      return(invisible(NULL))
    }
    notify_client(method)
  }, 0)
  TRUE
}

.workspace_update_task_callback <- function(..., schedule = later::later) {
  # An attached arf terminal can edit the same object outside Interactive cells.
  .sess_env$dataview_revision <- (.sess_env$dataview_revision %||% 0) + 1
  .defer_runtime_notification("workspace_updated", schedule)
}

#' Start the VS Code runtime integration (internal)
#'
#' @keywords internal
runtime_start <- function(use_rstudioapi = TRUE,
                          plot_backend = c("auto", "jgd", "httpgd", "standard", "native")) {
  plot_backend <- match.arg(plot_backend)
  .sess_env$runtime_start_phase <- "initialize"
  state <- .runtime_state()
  if (isTRUE(state$active)) {
    .sess_env$runtime_start_phase <- "previous-runtime-stop"
    runtime_stop()
  }
  state <- .runtime_state()
  state$active <- TRUE
  completed <- FALSE
  on.exit({
    if (!completed) {
      try(runtime_stop(), silent = TRUE)
    } else {
      .sess_env$runtime_start_phase <- NULL
    }
  }, add = TRUE)

  # 1. Override View() to serve table data via paged RPC.
  .sess_env$runtime_start_phase <- "view"
  if (is.null(.sess_env$dataview_registry)) {
    .runtime_set_field("dataview_registry", new.env(parent = emptyenv()))
  }

  show_dataview <- function(x, title = deparse(substitute(x))) {
    # Capture the root before forcing x so View(x$a) shares the viewer for x.
    original_expression <- substitute(x)
    expression <- original_expression
    while (is.call(expression) && is.symbol(expression[[1L]]) &&
             as.character(expression[[1L]]) %in% c("$", "[[", "@")) {
      expression <- expression[[2L]]
    }
    owner <- .sess_env$view_owner
    if (is.null(owner) && missing(title) && is.symbol(expression)) {
      owner <- as.character(expression)
    }
    force(title)

    if (isTRUE(.sess_env$interactive_connected) && .interactive_rich_value(x)) {
      return(invisible(NULL))
    }

    view_type <- if (dataview_is_table(x)) {
      "table"
    } else if (listview_supported(x)) {
      "list"
    } else {
      "object"
    }
    title_key <- paste(as.character(title), collapse = "\n")
    owner <- owner %||% title_key
    registry_key <- paste0(view_type, ":", owner)
    dataview_registry <- .sess_env$dataview_registry
    view_id <- if (nzchar(title_key) &&
                     exists(registry_key, envir = dataview_registry, inherits = FALSE)) {
      get(registry_key, envir = dataview_registry, inherits = FALSE)
    } else {
      id <- dataview_new_id()
      if (nzchar(title_key)) {
        assign(registry_key, id, envir = dataview_registry)
      }
      id
    }

    if (view_type == "table") {
      registration <- dataview_register(x, view_id = view_id)

      notify_client("dataview", list(
        title = title,
        source = "table",
        type = "json",
        view_id = registration$view_id,
        instance = registration$instance
      ))
    } else if (view_type == "list") {
      context <- .sess_env$listview_context
      if (is.null(context) && missing(title)) {
        context <- listview_expression_context(original_expression, parent.frame(), owner, x)
      }
      root <- if (is.null(context)) listview_state(x, title_key, owner) else context$root
      navigation <- if (is.null(context)) {
        listview_navigation(listview_location(root))
      } else {
        context$navigation
      }
      root <- dataview_set_state(view_id, root)
      notify_client("dataview", list(
        title = title,
        source = view_type,
        type = "json",
        view_id = view_id,
        instance = root$instance,
        navigation = navigation
      ))
    } else {
      code <- if (is.primitive(x)) utils::capture.output(print(x)) else deparse(x)
      file_path <- .sess_env$dataviews[[view_id]]$file %||%
        tempfile(tmpdir = .sess_env$tempdir, fileext = ".R")
      writeLines(code, file_path)
      .sess_env$dataviews[[view_id]] <- list(type = "object", file = file_path)
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
  .sess_env$runtime_start_phase <- "viewer-options"
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
  .sess_env$runtime_start_phase <- "help-s3"
  sess_print.help_files_with_topic <- function(x, ...) {
    if (length(x) >= 1 && is.character(x)) {
      file <- x[1]
      pkgname <- basename(dirname(dirname(file)))
      requestPath <- paste0("/library/", pkgname, "/html/", basename(file), ".html")
      notify_client("help", list(
        requestPath = requestPath
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
        requestPath = requestPath
      ))
    } else {
      utils:::print.hsearch(x, ...)
    }
    invisible(x)
  }
  # 4. Plot device: JGD > httpgd > Standard, or no plot integration for native
  .sess_env$runtime_start_phase <- "plot"
  has_jgd <- plot_backend %in% c("auto", "jgd") &&
    nzchar(Sys.getenv("JGD_SOCKET")) && requireNamespace("jgd", quietly = TRUE)
  has_httpgd <- plot_backend %in% c("auto", "httpgd") &&
    requireNamespace("httpgd", quietly = TRUE)
  selected_backend <- .select_plot_backend(plot_backend, has_httpgd, has_jgd)
  if (selected_backend == "jgd") {
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
  } else if (selected_backend == "httpgd") {
    .runtime_set_option("device", function(...) {
      httpgd::hgd(silent = TRUE)
      .runtime_track_device()
      notify_client("httpgd", list(url = httpgd::hgd_url()))
    })
  } else if (selected_backend == "standard") {
    # If a specific interactive backend was explicitly requested but is
    # unavailable, warn before silently degrading to the standard viewer.
    # Auto is meant to degrade quietly.
    if (plot_backend %in% c("jgd", "httpgd")) {
      if (plot_backend == "jgd" && !requireNamespace("jgd", quietly = TRUE)) {
        warning("[sess] Plot backend \"jgd\" was requested but the jgd package ",
                "is not installed. Falling back to the standard plot viewer. ",
                "Install jgd, or change the r.plot.backend setting.", call. = FALSE)
      } else if (plot_backend == "jgd") {
        warning("[sess] Plot backend \"jgd\" was requested but no renderer ",
                "connection is available. Falling back to the standard plot ",
                "viewer.", call. = FALSE)
      } else if (plot_backend == "httpgd") {
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
                .defer_runtime_notification("plot_updated")
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
      update_plot(...)
    }, name = "sess.plot")
  }

  # 5. rstudioapi hooks
  .sess_env$runtime_start_phase <- "rstudioapi"
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
  .sess_env$runtime_start_phase <- "workspace-callback"
  # This notifies the client whenever a top-level command is completed,
  # suggesting that the Global Environment might have changed.
  .runtime_add_task_callback(.workspace_update_task_callback, name = "sess.workspace")

  completed <- TRUE
  invisible(NULL)
}
