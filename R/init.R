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
      session_file <- file.path(dir_session, "session.json")
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
      unlockBinding(".External.graphics", baseenv())
      assign(".External.graphics", function(...) {
        plot_updated <<- TRUE
        .prim <- .Primitive(".External.graphics")
        .prim(...)
      }, baseenv())
      lockBinding(".External.graphics", baseenv())

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
        session <- list(
          pid = pid,
          args = commandArgs(),
          wd = getwd(),
          time = Sys.time()
        )
        jsonlite::write_json(session, session_file, auto_unbox = TRUE, pretty = TRUE)
        objs <- eapply(.GlobalEnv, function(obj) {
          list(
            class = class(obj),
            type = typeof(obj),
            length = length(obj),
            names = names(obj),
            str = utils::capture.output(str(obj, max.level = 0, give.attr = FALSE))
          )
        }, all.names = FALSE, USE.NAMES = TRUE)
        jsonlite::write_json(objs, globalenv_file, auto_unbox = TRUE, pretty = TRUE)
        if (grDevices::dev.cur() == 2L && plot_updated) {
          plot_updated <<- FALSE
          record <- grDevices::recordPlot()
          if (length(record[[1]])) {
            grDevices::png(plot_file)
            on.exit(grDevices::dev.off())
            grDevices::replayPlot(record)
          }
        }
        TRUE
      }

      attach <- function() {
        respond("attach")
      }

      dataview <- function(name) {
        obj <- get(name, envir = .GlobalEnv)
        if (is.data.frame(obj)) {
          file <- file.path(tempdir, paste0(name, ".csv"))
          write.csv(obj, file)
          respond("dataview", type = "csv", file = file)
        } else if (is.list(obj)) {
          file <- file.path(tempdir, paste0(name, ".json"))
          jsonlite::write_json(obj, file, auto_unbox = TRUE)
          respond("dataview", type = "json", file = file)
        } else {
          stop("Unsupported object class")
        }
      }
      update()
      addTaskCallback(update, name = "vscode-R")
      lockEnvironment(environment(), bindings = TRUE)
      unlockBinding("plot_updated", environment())
      attach()
    }
    invisible()
  })
}
