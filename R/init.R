if (interactive() && !identical(Sys.getenv("RSTUDIO"), "1")) {
  local({
    pid <- Sys.getpid()
    tempdir <- tempdir(check = TRUE)
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

      options(viewer = function(url, ...) {
        respond("webview", file = url)
      })
      options(page_viewer = function(url, ...) {
        respond("webview", file = url)
      })

      respond <- function(command, ...) {
        json <- jsonlite::toJSON(list(pid = pid, command = command, ...), auto_unbox = TRUE)
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

      dataview <- function(x, title, ...) {
        if (missing(title)) {
          title <- deparse(substitute(x))[[1]]
        }
        filename <- make.names(title)
        if (is.data.frame(x)) {
          file <- file.path(tempdir, paste0(filename, ".html"))
          html <- knitr::kable(x = x, format = "html", ...)
          writeLines(html, file)
          respond("dataview", source = "data.frame", type = "html",
            title = title, file = file)
        } else if (is.list(obj)) {
          file <- file.path(tempdir, paste0(filename, ".json"))
          jsonlite::write_json(obj, file, auto_unbox = TRUE)
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
