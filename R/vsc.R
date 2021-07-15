pid <- Sys.getpid()
wd <- getwd()
tempdir <- tempdir()
homedir <- Sys.getenv(
  if (.Platform$OS.type == "windows") "USERPROFILE" else "HOME"
)
dir_watcher <- Sys.getenv("VSCODE_WATCHER_DIR", file.path(homedir, ".vscode-R"))
request_file <- file.path(dir_watcher, "request.log")
request_lock_file <- file.path(dir_watcher, "request.lock")

if (is.null(getOption("help_type"))) {
  options(help_type = "html")
}

get_timestamp <- function() {
  format.default(Sys.time(), nsmall = 6, scientific = FALSE)
}

scalar <- function(x) {
  class(x) <- c("scalar", class(x))
  x
}

request <- function(command, ...) {
  obj <- list(
    time = Sys.time(),
    pid = pid,
    wd = wd,
    command = command,
    ...
  )
  jsonlite::write_json(obj, request_file,
    auto_unbox = TRUE, null = "null", force = TRUE)
  cat(get_timestamp(), file = request_lock_file)
}

capture_str <- function(object, max.level = getOption("vsc.str.max.level", 0)) {
  paste0(
    utils::capture.output(
      utils::str(object,
        max.level = max.level,
        give.attr = FALSE,
        vec.len = 1
      )
    ),
    collapse = "\n"
  )
}

rebind <- function(sym, value, ns) {
  if (is.character(ns)) {
    Recall(sym, value, getNamespace(ns))
    pkg <- paste0("package:", ns)
    if (pkg %in% search()) {
      Recall(sym, value, as.environment(pkg))
    }
  } else if (is.environment(ns)) {
    if (bindingIsLocked(sym, ns)) {
      unlockBinding(sym, ns)
      on.exit(lockBinding(sym, ns))
    }
    assign(sym, value, ns)
  } else {
    stop("ns must be a string or environment")
  }
}

address <- function(x) {
  info <- utils::capture.output(.Internal(inspect(x, 0L)))
  gsub("@([a-z0-9]+)\\s+.+", "\\1", info[[1]])
}

globalenv_cache <- new.env(parent = emptyenv())

inspect_env <- function(env, cache) {
  all_names <- ls(env)
  rm(list = setdiff(names(globalenv_cache), all_names), envir = cache)
  is_promise <- rlang::env_binding_are_lazy(env, all_names)
  is_active <- rlang::env_binding_are_active(env, all_names)
  show_object_size <- getOption("vsc.show_object_size", FALSE)
  objs <- lapply(all_names, function(name) {
    if (is_promise[[name]]) {
      info <- list(
        class = "promise",
        type = scalar("promise"),
        length = scalar(0L),
        str = scalar("(promise)")
      )
    } else if (is_active[[name]]) {
      info <- list(
        class = "active_binding",
        type = scalar("active_binding"),
        length = scalar(0L),
        str = scalar("(active-binding)")
      )
    } else {
      obj <- env[[name]]

      info <- list(
        class = class(obj),
        type = scalar(typeof(obj)),
        length = scalar(length(obj)),
        str = scalar(trimws(capture_str(obj)[[1L]]))
      )

      if (show_object_size) {
        addr <- address(obj)
        cobj <- cache[[name]]
        if (is.null(cobj) || cobj$address != addr || cobj$length != info$length) {
          cache[[name]] <- cobj <- list(
            address = addr,
            length = length(obj),
            size = unclass(object.size(obj))
          )
        }
        info$size <- scalar(cobj$size)
      }

      obj_names <- if (is.object(obj)) {
        .DollarNames(obj)
      } else if (is.recursive(obj)) {
        names(obj)
      } else NULL

      if (length(obj_names)) {
        info$names <- obj_names
      }

      if (isS4(obj)) {
        info$slots <- slotNames(obj)
      }

      if (is.list(obj) && !is.null(dim(obj))) {
        info$dim <- dim(obj)
      }
    }
    info
  })
  names(objs) <- all_names
  objs
}

dir_session <- file.path(tempdir, "vscode-R")
dir.create(dir_session, showWarnings = FALSE, recursive = TRUE)

removeTaskCallback("vsc.globalenv")
show_globalenv <- isTRUE(getOption("vsc.globalenv", TRUE))
if (show_globalenv) {
  globalenv_file <- file.path(dir_session, "globalenv.json")
  globalenv_lock_file <- file.path(dir_session, "globalenv.lock")
  file.create(globalenv_lock_file, showWarnings = FALSE)

  update_globalenv <- function(...) {
    tryCatch({
      objs <- inspect_env(.GlobalEnv, globalenv_cache)
      jsonlite::write_json(objs, globalenv_file, force = TRUE, pretty = FALSE)
      cat(get_timestamp(), file = globalenv_lock_file)
    }, error = message)
    TRUE
  }

  update_globalenv()
  addTaskCallback(update_globalenv, name = "vsc.globalenv")
}

removeTaskCallback("vsc.plot")
use_httpgd <- identical(getOption("vsc.use_httpgd", FALSE), TRUE)
show_plot <- !identical(getOption("vsc.plot", "Two"), FALSE)
if (use_httpgd && "httpgd" %in% .packages(all.available = TRUE)) {
  options(device = function(...) {
    httpgd::hgd(
      silent = TRUE
    )
    .vsc$request("httpgd", url = httpgd::hgd_url())
  })
} else if (use_httpgd) {
  message("Install package `httpgd` to use vscode-R with httpgd!")
} else if (show_plot) {
  plot_file <- file.path(dir_session, "plot.png")
  plot_lock_file <- file.path(dir_session, "plot.lock")
  file.create(plot_file, plot_lock_file, showWarnings = FALSE)

  plot_updated <- FALSE
  null_dev_id <- c(pdf = 2L)
  null_dev_size <- c(7 + pi, 7 + pi)

  check_null_dev <- function() {
    identical(dev.cur(), null_dev_id) &&
      identical(dev.size(), null_dev_size)
  }

  new_plot <- function() {
    if (check_null_dev()) {
      plot_updated <<- TRUE
    }
  }

  options(
    device = function(...) {
      pdf(NULL,
        width = null_dev_size[[1L]],
        height = null_dev_size[[2L]],
        bg = "white")
      dev.control(displaylist = "enable")
    }
  )

  update_plot <- function(...) {
    tryCatch({
      if (plot_updated && check_null_dev()) {
        plot_updated <<- FALSE
        record <- recordPlot()
        if (length(record[[1L]])) {
          dev_args <- getOption("vsc.dev.args")
          do.call(png, c(list(filename = plot_file), dev_args))
          on.exit({
            dev.off()
            cat(get_timestamp(), file = plot_lock_file)
          })
          replayPlot(record)
        }
      }
    }, error = message)
    TRUE
  }

  setHook("plot.new", new_plot, "replace")
  setHook("grid.newpage", new_plot, "replace")

  rebind(".External.graphics", function(...) {
    out <- .Primitive(".External.graphics")(...)
    if (check_null_dev()) {
      plot_updated <<- TRUE
    }
    out
  }, "base")

  update_plot()
  addTaskCallback(update_plot, name = "vsc.plot")
}

show_view <- !identical(getOption("vsc.view", "Two"), FALSE)
if (show_view) {
  get_column_def <- function(name, field, value) {
    filter <- TRUE
    if (is.numeric(value)) {
      type <- "numericColumn"
      if (is.null(attr(value, "class"))) {
        filter <- "agNumberColumnFilter"
      }
    } else if (inherits(value, "Date")) {
      type <- "dateColumn"
      filter <- "agDateColumnFilter"
    } else {
      type <- "textColumn"
      filter <- "agTextColumnFilter"
    }
    list(
      headerName = name,
      field = field,
      type = type,
      filter = filter
    )
  }

  dataview_table <- function(data) {
    if (is.matrix(data)) {
      data <- as.data.frame.matrix(data)
    }

    if (is.data.frame(data)) {
      nrow <- nrow(data)
      colnames <- colnames(data)
      if (is.null(colnames)) {
        colnames <- sprintf("V%d", seq_len(ncol(data)))
      } else {
        colnames <- trimws(colnames)
      }
      if (.row_names_info(data) > 0L) {
        rownames <- rownames(data)
        rownames(data) <- NULL
      } else {
        rownames <- seq_len(nrow)
      }
      colnames <- c("(row)", colnames)
      fields <- sprintf("x%d", seq_along(colnames))
      data <- c(list(" " = rownames), .subset(data))
      names(data) <- fields
      class(data) <- "data.frame"
      attr(data, "row.names") <- .set_row_names(nrow)
      columns <- .mapply(get_column_def,
        list(colnames, fields, data),
        NULL
      )
      list(
        columns = columns,
        data = data
      )
    } else {
      stop("data must be a data.frame or a matrix")
    }
  }

  show_dataview <- function(x, title, uuid = NULL,
                            viewer = getOption("vsc.view", "Two")) {
    if (missing(title)) {
      sub <- substitute(x)
      title <- deparse(sub, nlines = 1)
    }
    if (is.environment(x)) {
      all_names <- ls(x)
      is_promise <- rlang::env_binding_are_lazy(x, all_names)
      is_active <- rlang::env_binding_are_active(x, all_names)
      x <- lapply(all_names, function(name) {
        if (is_promise[[name]]) {
          data.frame(
            class = "promise",
            type = "promise",
            length = 0L,
            size = 0L,
            value = "(promise)",
            stringsAsFactors = FALSE,
            check.names = FALSE
          )
        } else if (is_active[[name]]) {
          data.frame(
            class = "active_binding",
            type = "active_binding",
            length = 0L,
            size = 0L,
            value = "(active-binding)",
            stringsAsFactors = FALSE,
            check.names = FALSE
          )
        } else {
          obj <- x[[name]]
          data.frame(
            class = paste0(class(obj), collapse = ", "),
            type = typeof(obj),
            length = length(obj),
            size = as.integer(object.size(obj)),
            value = trimws(capture_str(obj, 0)),
            stringsAsFactors = FALSE,
            check.names = FALSE
          )
        }
      })
      names(x) <- all_names
      if (length(x)) {
        x <- do.call(rbind, x)
      } else {
        x <- data.frame(
          class = character(),
          type = character(),
          length = integer(),
          size = integer(),
          value = character(),
          stringsAsFactors = FALSE,
          check.names = FALSE
        )
      }
    }
    if (is.data.frame(x) || is.matrix(x)) {
      data <- dataview_table(x)
      file <- tempfile(tmpdir = tempdir, fileext = ".json")
      jsonlite::write_json(data, file, auto_unbox = TRUE)
      request("dataview", source = "table", type = "json",
        title = title, file = file, viewer = viewer, uuid = uuid)
    } else if (is.list(x)) {
      tryCatch({
        file <- tempfile(tmpdir = tempdir, fileext = ".json")
        jsonlite::write_json(x, file, auto_unbox = TRUE)
        request("dataview", source = "list", type = "json",
          title = title, file = file, viewer = viewer, uuid = uuid)
      }, error = function(e) {
        file <- file.path(tempdir, paste0(make.names(title), ".txt"))
        text <- utils::capture.output(print(x))
        writeLines(text, file)
        request("dataview", source = "object", type = "txt",
          title = title, file = file, viewer = viewer, uuid = uuid)
      })
    } else {
      file <- file.path(tempdir, paste0(make.names(title), ".R"))
      if (is.primitive(x)) {
        code <- utils::capture.output(print(x))
      } else {
        code <- deparse(x)
      }
      writeLines(code, file)
      request("dataview", source = "object", type = "R",
        title = title, file = file, viewer = viewer, uuid = uuid)
    }
  }

  View <- show_dataview
}

attach <- function() {
  if (rstudioapi_enabled()) {
    rstudioapi_util_env$update_addin_registry(addin_registry)
  }
  request("attach",
    tempdir = tempdir,
    plot = getOption("vsc.plot", "Two")
  )
  if (identical(names(dev.cur()), "httpgd")) {
    .vsc$request("httpgd", url = httpgd::hgd_url())
  }
}

path_to_uri <- function(path) {
  if (length(path) == 0) {
    return(character())
  }
  path <- path.expand(path)
  if (.Platform$OS.type == "windows") {
    prefix <- "file:///"
    path <- gsub("\\", "/", path, fixed = TRUE)
  } else {
    prefix <- "file://"
  }
  paste0(prefix, utils::URLencode(path))
}

request_browser <- function(url, title, ..., viewer) {
  # Printing URL with specific port triggers
  # auto port-forwarding under remote development
  message("Browsing ", url)
  request("browser", url = url, title = title, ..., viewer = viewer)
}

show_browser <- function(url, title = url, ...,
                         viewer = getOption("vsc.browser", "Active")) {
  if (grepl("^https?\\://(127\\.0\\.0\\.1|localhost)(\\:\\d+)?", url)) {
    request_browser(url = url, title = title, ..., viewer = viewer)
  } else if (grepl("^https?\\://", url)) {
    message(
      "VSCode WebView only supports showing local http content.\n",
      "Opening in external browser..."
    )
    request_browser(url = url, title = title, ..., viewer = FALSE)
  } else if (file.exists(url)) {
    url <- normalizePath(url, "/", mustWork = TRUE)
    if (grepl("\\.html?$", url, ignore.case = TRUE)) {
      message(
        "VSCode WebView has restricted access to local file.\n",
        "Opening in external browser..."
      )
      request_browser(url = path_to_uri(url),
        title = title, ..., viewer = FALSE)
    } else {
      request("dataview", source = "object", type = "txt",
        title = title, file = url, viewer = viewer)
    }
  } else {
    stop("File not exists")
  }
}

show_webview <- function(url, title, ..., viewer) {
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
  if (grepl("^https?\\://(127\\.0\\.0\\.1|localhost)(\\:\\d+)?", url)) {
    request_browser(url = url, title = title, ..., viewer = viewer)
  } else if (grepl("^https?\\://", url)) {
    message(
      "VSCode WebView only supports showing local http content.\n",
      "Opening in external browser..."
    )
    request_browser(url = url, title = title, ..., viewer = FALSE)
  } else if (file.exists(url)) {
    file <- normalizePath(url, "/", mustWork = TRUE)
    request("webview", file = file, title = title, viewer = viewer, ...)
  } else {
    stop("File not exists")
  }
}

show_viewer <- function(url, title = NULL, ...,
                        viewer = getOption("vsc.viewer", "Two")) {
  if (is.null(title)) {
    expr <- substitute(url)
    if (is.character(url)) {
      title <- "Viewer"
    } else {
      title <- deparse(expr, nlines = 1)
    }
  }
  show_webview(url = url, title = title, ..., viewer = viewer)
}

show_page_viewer <- function(url, title = NULL, ...,
                             viewer = getOption("vsc.page_viewer", "Active")) {
  if (is.null(title)) {
    expr <- substitute(url)
    if (is.character(url)) {
      title <- "Page Viewer"
    } else {
      title <- deparse(expr, nlines = 1)
    }
  }
  show_webview(url = url, title = title, ..., viewer = viewer)
}

options(
  browser = show_browser,
  viewer = show_viewer,
  page_viewer = show_page_viewer
)

# rstudioapi
rstudioapi_enabled <- function() {
  isTRUE(getOption("vsc.rstudioapi"))
}

if (rstudioapi_enabled()) {
  response_timeout <- 5
  response_lock_file <- file.path(dir_session, "response.lock")
  response_file <- file.path(dir_session, "response.log")
  file.create(response_lock_file, showWarnings = FALSE)
  file.create(response_file, showWarnings = FALSE)
  addin_registry <- file.path(dir_session, "addins.json")
  # This is created in attach()

  get_response_timestamp <- function() {
    readLines(response_lock_file)
  }
  # initialise the reponse timestamp to empty string
  response_time_stamp <- ""

  get_response_lock <- function() {
    lock_time_stamp <- get_response_timestamp()
    if (isTRUE(lock_time_stamp != response_time_stamp)) {
      response_time_stamp <<- lock_time_stamp
      TRUE
    } else {
      FALSE
    }
  }

  request_response <- function(command, ...) {
    request(command, ..., sd = dir_session)
    wait_start <- Sys.time()
    while (!get_response_lock()) {
      if ((Sys.time() - wait_start) > response_timeout) {
        stop(
          "Did not receive a response from VSCode-R API within ",
          response_timeout, " seconds."
        )
      }
      Sys.sleep(0.1)
    }
    jsonlite::read_json(response_file)
  }

  rstudioapi_util_env <- new.env()
  rstudioapi_env <- new.env(parent = rstudioapi_util_env)
  source(file.path(dir_init, "rstudioapi_util.R"), local = rstudioapi_util_env)
  source(file.path(dir_init, "rstudioapi.R"), local = rstudioapi_env)
  setHook(
    packageEvent("rstudioapi", "onLoad"),
    function(...) {
      rstudioapi_util_env$rstudioapi_patch_hook(rstudioapi_env)
    }
  )
  if ("rstudioapi" %in% loadedNamespaces()) {
    # if the rstudioapi is already loaded, for example via a call to
    # library(tidyverse) in the user's profile, we need to shim it now.
    # There's no harm in having also registered the hook in this case. It can
    # work in the event that the namespace is unloaded and reloaded.
    rstudioapi_util_env$rstudioapi_patch_hook(rstudioapi_env)
  }

}

print.help_files_with_topic <- function(h, ...) {
  viewer <- getOption("vsc.helpPanel", "Two")
  if (!identical(FALSE, viewer) && length(h) >= 1 && is.character(h)) {
    file <- h[1]
    path <- dirname(file)
    dirpath <- dirname(path)
    pkgname <- basename(dirpath)
    requestPath <- paste0(
      "/library/",
      pkgname,
      "/html/",
      basename(file),
      ".html"
    )
    request(command = "help", requestPath = requestPath, viewer = viewer)
  } else {
    utils:::print.help_files_with_topic(h, ...)
  }
  invisible(h)
}

print.hsearch <- function(x, ...) {
  viewer <- getOption("vsc.helpPanel", "Two")
  if (!identical(FALSE, viewer) && length(x) >= 1) {
    requestPath <- paste0(
      "/doc/html/Search?pattern=",
      tools:::escapeAmpersand(x$pattern),
      paste0("&fields.", x$fields, "=1",
        collapse = ""
      ),
      if (!is.null(x$agrep)) paste0("&agrep=", x$agrep),
      if (!x$ignore.case) "&ignore.case=0",
      if (!identical(
        x$types,
        getOption("help.search.types")
      )) {
        paste0("&types.", x$types, "=1",
          collapse = ""
        )
      },
      if (!is.null(x$package)) {
        paste0(
          "&package=",
          paste(x$package, collapse = ";")
        )
      },
      if (!identical(x$lib.loc, .libPaths())) {
        paste0(
          "&lib.loc=",
          paste(x$lib.loc, collapse = ";")
        )
      }
    )
    request(command = "help", requestPath = requestPath, viewer = viewer)
  } else {
    utils:::print.hsearch(x, ...)
  }
  invisible(x)
}

# a copy of .S3method(), since this function is new in R 4.0
.S3method <- function(generic, class, method) {
  if (missing(method)) {
    method <- paste(generic, class, sep = ".")
  }
  method <- match.fun(method)
  registerS3method(generic, class, method, envir = parent.frame())
  invisible(NULL)
}
