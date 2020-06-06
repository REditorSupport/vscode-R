if (interactive() &&
  Sys.getenv("RSTUDIO") == "" &&
  Sys.getenv("TERM_PROGRAM") == "vscode") {
  if (requireNamespace("jsonlite", quietly = TRUE)) {
    local({
      pid <- Sys.getpid()
      wd <- getwd()
      tempdir <- tempdir()
      homedir <- Sys.getenv(
        if (.Platform$OS.type == "windows") "USERPROFILE" else "HOME"
      )
      dir_extension <- file.path(homedir, ".vscode-R")
      dir_session <- file.path(tempdir, "vscode-R")
      dir.create(dir_session, showWarnings = FALSE, recursive = TRUE)
      dir_plot_history <- file.path(dir_session, "images")
      dir.create(dir_plot_history, showWarnings = FALSE, recursive = TRUE)

      request_file <- file.path(dir_extension, "request.log")
      request_lock_file <- file.path(dir_extension, "request.lock")
      globalenv_file <- file.path(dir_session, "globalenv.json")
      globalenv_lock_file <- file.path(dir_session, "globalenv.lock")
      plot_file <- file.path(dir_session, "plot.png")
      plot_lock_file <- file.path(dir_session, "plot.lock")
      plot_history_file <- NULL
      plot_updated <- FALSE
      null_dev_id <- c(pdf = 2L)
      null_dev_size <- c(7 + pi, 7 + pi)

      file.create(globalenv_lock_file, plot_lock_file, showWarnings = FALSE)

      get_timestamp <- function() {
        format.default(Sys.time(), nsmall = 6)
      }

      check_null_dev <- function() {
        identical(dev.cur(), null_dev_id) &&
          identical(dev.size(), null_dev_size)
      }

      new_plot <- function() {
        if (check_null_dev()) {
          plot_history_file <<- file.path(dir_plot_history,
            format(Sys.time(), "%Y%m%d-%H%M%OS6.png"))
          plot_updated <<- TRUE
        }
      }

      options(
        vscodeR = environment(),
        device = function(...) {
          pdf(NULL,
            width = null_dev_size[[1L]],
            height = null_dev_size[[2L]],
            bg = "white")
          dev.control(displaylist = "enable")
        },
        browser = function(url, ...) {
          request("browser", url = url, ...)
        },
        viewer = function(url, ...) {
          request("webview", file = url, ..., viewColumn = "Two")
        },
        page_viewer = function(url, ...) {
          request("webview", file = url, ..., viewColumn = "Active")
        },
        help_type = "html"
      )

      request <- function(command, ...) {
        json <- jsonlite::toJSON(list(
          time = Sys.time(),
          pid = pid,
          wd = wd,
          command = command,
          ...
        ), auto_unbox = TRUE)
        cat(json, "\n", sep = "", file = request_file)
        cat(get_timestamp(), file = request_lock_file)
      }

      unbox <- jsonlite::unbox

      capture_str <- function(object) {
        utils::capture.output(
          utils::str(object, max.level = 0, give.attr = FALSE)
        )
      }

      update <- function(...) {
        tryCatch({
          objs <- eapply(.GlobalEnv, function(obj) {
            str <- capture_str(obj)[[1L]]
            info <- list(
              class = class(obj),
              type = unbox(typeof(obj)),
              length = unbox(length(obj)),
              str = unbox(trimws(str))
            )
            if ((is.list(obj) ||
              is.environment(obj)) &&
              !is.null(names(obj))) {
              info$names <- names(obj)
            }
            if (isS4(obj)) {
              info$slots <- slotNames(obj)
            }
            info
          }, all.names = FALSE, USE.NAMES = TRUE)
          jsonlite::write_json(objs, globalenv_file, pretty = FALSE)
          cat(get_timestamp(), file = globalenv_lock_file)
          if (plot_updated && check_null_dev()) {
            plot_updated <<- FALSE
            record <- recordPlot()
            if (length(record[[1L]])) {
              dev_args <- getOption("dev.args")
              do.call(png, c(list(filename = plot_file), dev_args))
              on.exit({
                dev.off()
                cat(get_timestamp(), file = plot_lock_file)
                if (!is.null(plot_history_file)) {
                  file.copy(plot_file, plot_history_file, overwrite = TRUE)
                }
              })
              replayPlot(record)
            }
          }
        }, error = message)
        TRUE
      }

      attach <- function() {
        request("attach", tempdir = tempdir)
      }

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
            character(1L), USE.NAMES = FALSE)
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
        columns <- .mapply(function(title, type) {
          class <- if (type == "string") "text-left" else "text-right"
          list(title = jsonlite::unbox(title),
            className = jsonlite::unbox(class),
            type = jsonlite::unbox(type))
        }, list(colnames, types), NULL)
        list(columns = columns, data = data)
      }

      dataview <- function(x, title) {
        if (missing(title)) {
          sub <- substitute(x)
          title <- deparse(sub)[[1]]
        }
        if (is.environment(x)) {
          x <- eapply(x, function(obj) {
            data.frame(
              class = paste0(class(obj), collapse = ", "),
              type = typeof(obj),
              length = length(obj),
              size = as.integer(object.size(obj)),
              value = trimws(capture_str(obj)),
              stringsAsFactors = FALSE,
              check.names = FALSE
            )
          }, all.names = FALSE, USE.NAMES = TRUE)
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
          jsonlite::write_json(data, file, matrix = "rowmajor")
          request("dataview", source = "table", type = "json",
            title = title, file = file)
        } else if (is.list(x)) {
          tryCatch({
            file <- tempfile(tmpdir = tempdir, fileext = ".json")
            jsonlite::write_json(x, file, auto_unbox = TRUE)
            request("dataview", source = "list", type = "json",
              title = title, file = file)
          }, error = function(e) {
            file <- file.path(tempdir, paste0(make.names(title), ".txt"))
            text <- utils::capture.output(print(x))
            writeLines(text, file)
            request("dataview", source = "object", type = "txt",
              title = title, file = file)
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
            title = title, file = file)
        }
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

      setHook("plot.new", new_plot, "replace")
      setHook("grid.newpage", new_plot, "replace")

      rebind(".External.graphics", function(...) {
        out <- .Primitive(".External.graphics")(...)
        if (check_null_dev()) {
          plot_updated <<- TRUE
        }
        out
      }, "base")
      rebind("View", dataview, "utils")

      platform <- .Platform
      platform[["GUI"]] <- "vscode"
      rebind(".Platform", platform, "base")

      update()
      removeTaskCallback("vscode-R")
      addTaskCallback(update, name = "vscode-R")
      lockEnvironment(environment(), bindings = TRUE)
      unlockBinding("plot_updated", environment())
      unlockBinding("plot_history_file", environment())
      attach()
      invisible()
    })
  } else {
    message("VSCode R Session Watcher requires jsonlite.")
    message("Please install it with install.packages(\"jsonlite\").")
  }
}
