if (interactive() && 
  is.null(getOption("vscodeR")) && 
  !identical(Sys.getenv("RSTUDIO"), "1")) {
  local({
    pid <- Sys.getpid()
    tempdir <- tempdir()
    dir <- normalizePath(file.path(".vscode", "vscode-R"), mustWork = FALSE)
    dir_session <- file.path(dir, pid)
    if (dir.create(dir_session, showWarnings = FALSE, recursive = TRUE) || dir.exists(dir_session)) {
      reg.finalizer(.GlobalEnv, function(e) {
        unlink(dir_session, recursive = TRUE, force = TRUE)
      }, onexit = TRUE)

      dir_plot_history <- file.path(tempdir, "images")
      dir.create(dir_plot_history, showWarnings = FALSE, recursive = TRUE)

      response_file <- file.path(dir, "response.log")
      globalenv_file <- file.path(dir_session, "globalenv.json")
      plot_file <- file.path(dir_session, "plot.png")
      plot_history_file <- NULL
      plot_updated <- FALSE

      new_plot <- function() {
        plot_history_file <<- file.path(dir_plot_history,
          format(Sys.time(), "%Y%m%d-%H%M%OS3.png"))
        plot_updated <<- TRUE
      }

      options(vscodeR = environment())
      options(device = function(...) {
        pdf(NULL, bg = "white")
        dev.control(displaylist = "enable")
      })
      setHook("plot.new", new_plot, "replace")
      setHook("grid.newpage", new_plot, "replace")

      options(browser = function(url, ...) {
        respond("browser", url = url)
      })
      options(viewer = function(url, ...) {
        respond("webview", file = url)
      })
      options(page_viewer = function(url, ...) {
        respond("webview", file = url)
      })

      respond <- function(command, ...) {
        json <- jsonlite::toJSON(list(
          time = Sys.time(),
          pid = pid,
          command = command,
          ...
        ), auto_unbox = TRUE)
        cat(json, "\n", file = response_file, append = TRUE)
      }

      update <- function(...) {
        objs <- eapply(.GlobalEnv, function(obj) {
          list(
            class = class(obj),
            type = typeof(obj),
            length = length(obj),
            str = trimws(utils::capture.output(utils::str(obj, max.level = 0, give.attr = FALSE)))
          )
        }, all.names = FALSE, USE.NAMES = TRUE)
        jsonlite::write_json(objs, globalenv_file, auto_unbox = TRUE, pretty = TRUE)
        if (plot_updated && dev.cur() == 2L) {
          plot_updated <<- FALSE
          record <- recordPlot()
          if (length(record[[1]])) {
            png(plot_file)
            on.exit({
              dev.off()
              if (!is.null(plot_history_file)) {
                file.copy(plot_file, plot_history_file, overwrite = TRUE)
              }
            })
            replayPlot(record)
          }
        }
        TRUE
      }

      attach <- function() {
        respond("attach", tempdir = tempdir)
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
          colnames <- colnames(data)
          if (is.null(colnames)) {
            colnames <- sprintf("(X%d)", seq_len(ncol(data)))
          } else {
            colnames <- trimws(colnames)
          }
          if (.row_names_info(data) > 0L) {
            rownames <- rownames(data)
            rownames(data) <- NULL
            data <- cbind(rownames, data, stringsAsFactors = FALSE)
            colnames <- c(" ", colnames)
          }
          types <- vapply(data, dataview_data_type,
            character(1L), USE.NAMES = FALSE)
          data <- vapply(data, function(x) {
            trimws(format(x))
          }, character(nrow(data)), USE.NAMES = FALSE)
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
          if (!is.null(rownames)) {
            types <- c("string", types)
            colnames <- c(" ", colnames)
            data <- cbind(` ` = trimws(rownames), data)
          }
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
          title <- deparse(substitute(x))[[1]]
        }
        if (is.data.frame(x) || is.matrix(x)) {
          data <- dataview_table(x)
          file <- tempfile(tmpdir = tempdir, fileext = ".json")
          jsonlite::write_json(data, file, matrix = "rowmajor")
          respond("dataview", source = "table", type = "json",
            title = title, file = file)
        } else if (is.list(x)) {
          file <- tempfile(tmpdir = tempdir, fileext = ".json")
          jsonlite::write_json(x, file, auto_unbox = TRUE)
          respond("dataview", source = "list", type = "json",
            title = title, file = file)
        } else {
          stop("Unsupported object class")
        }
      }

      rebind <- function(sym, value, ns) {
        ns <- getNamespace(ns)
        unlockBinding(sym, ns)
        on.exit(lockBinding(sym, ns))
        assign(sym, value, envir = ns)
      }

      rebind(".External.graphics", function(...) {
        plot_updated <<- TRUE
        .prim <- .Primitive(".External.graphics")
        .prim(...)
      }, "base")
      rebind("View", dataview, "utils")

      update()
      addTaskCallback(update, name = "vscode-R")
      lockEnvironment(environment(), bindings = TRUE)
      unlockBinding("plot_updated", environment())
      unlockBinding("plot_history_file", environment())
      attach()
    }
    invisible()
  })
}
