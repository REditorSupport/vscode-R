if (interactive() && !identical(Sys.getenv("RSTUDIO"), "1")) {
  local({
    pid <- Sys.getpid()
    tempdir <- tempdir()
    dir <- normalizePath(file.path(".vscode", "vscode-R"), mustWork = FALSE)
    dir_session <- file.path(dir, pid)
    if (dir.create(dir_session, showWarnings = FALSE, recursive = TRUE) || dir.exists(dir_session)) {
      reg.finalizer(.GlobalEnv, function(e) {
        unlink(dir_session, recursive = TRUE, force = TRUE)
      }, onexit = TRUE)

      response_file <- file.path(dir, "response.log")
      globalenv_file <- file.path(dir_session, "globalenv.json")
      plot_file <- file.path(dir_session, "plot.png")
      plot_updated <- FALSE

      options(vscodeR = environment())
      options(device = function(...) {
        pdf(NULL, bg = "white")
        dev.control(displaylist = "enable")
      })
      setHook("plot.new", function(...) {
        plot_updated <<- TRUE
      })
      setHook("grid.newpage", function(...) {
        plot_updated <<- TRUE
      })

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
            str = trimws(utils::capture.output(str(obj, max.level = 0, give.attr = FALSE)))
          )
        }, all.names = FALSE, USE.NAMES = TRUE)
        jsonlite::write_json(objs, globalenv_file, auto_unbox = TRUE, pretty = TRUE)
        if (plot_updated && dev.cur() == 2L) {
          plot_updated <<- FALSE
          record <- recordPlot()
          if (length(record[[1]])) {
            png(plot_file)
            on.exit(dev.off())
            replayPlot(record)
          }
        }
        TRUE
      }

      attach <- function() {
        respond("attach")
      }

      table_to_json <- function(data) {
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
          size <- dim(data)
          types <- vapply(data, typeof, character(1L), USE.NAMES = FALSE)
          isf <- vapply(data, is.factor, logical(1L), USE.NAMES = FALSE)
          types[isf] <- "character"
          data <- vapply(data, function(x) {
            trimws(format(x))
          }, character(nrow(data)), USE.NAMES = FALSE)
        } else if (is.matrix(data)) {
          if (is.factor(data)) {
            data <- format(data)
          }
          types <- rep(typeof(data), ncol(data))
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
            types <- c("character", types)
            colnames <- c(" ", colnames)
            data <- cbind(` ` = trimws(rownames), data)
          }
          size <- dim(data)
        } else {
          stop("data must be data.frame or matrix")
        }
        list(size = size, columns = colnames, types = types, data = data)
      }

      dataview <- function(x, title, ...) {
        if (missing(title)) {
          title <- deparse(substitute(x))[[1]]
        }
        if (is.data.frame(x) || is.matrix(x)) {
          data <- table_to_json(x)
          file <- tempfile(tmpdir = tempdir, fileext = ".json")
          jsonlite::write_json(data, file, matrix = "columnmajor")
          respond("dataview", source = "table", type = "json",
            title = title, file = file)
        } else if (is.list(x)) {
          file <- tempfile(tmpdir = tempdir, fileext = ".json")
          jsonlite::write_json(x, file, auto_unbox = TRUE, ...)
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
      attach()
    }
    invisible()
  })
}
