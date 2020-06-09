if (interactive() &&
  Sys.getenv("RSTUDIO") == "" &&
  Sys.getenv("TERM_PROGRAM") == "vscode") {
  if (requireNamespace("jsonlite", quietly = TRUE)) local({
    .vsc.name <- "tools:vscode"
    if (.vsc.name %in% search()) {
      detach(.vsc.name, character.only = TRUE)
    }
    .vsc <- local({
      pid <- Sys.getpid()
      wd <- getwd()
      tempdir <- tempdir()
      homedir <- Sys.getenv(
        if (.Platform$OS.type == "windows") "USERPROFILE" else "HOME"
      )
      dir_extension <- file.path(homedir, ".vscode-R")
      request_file <- file.path(dir_extension, "request.log")
      request_lock_file <- file.path(dir_extension, "request.lock")

      options(help_type = "html")

      get_timestamp <- function() {
        format.default(Sys.time(), nsmall = 6)
      }

      watch_globalenv <- isTRUE(getOption("vsc.watch.globalenv", TRUE))
      if (watch_globalenv) {
        dir_session <- file.path(tempdir, "vscode-R")
        dir.create(dir_session, showWarnings = FALSE, recursive = TRUE)
        globalenv_file <- file.path(dir_session, "globalenv.json")
        globalenv_lock_file <- file.path(dir_session, "globalenv.lock")
        file.create(plot_lock_file, showWarnings = FALSE)
      }

      watch_plot <- isTRUE(getOption("vsc.watch.plot", TRUE))
      if (watch_plot) {
        dir_plot_history <- file.path(dir_session, "images")
        dir.create(dir_plot_history, showWarnings = FALSE, recursive = TRUE)
        plot_file <- file.path(dir_session, "plot.png")
        plot_lock_file <- file.path(dir_session, "plot.lock")
        plot_history_file <- NULL
        file.create(plot_lock_file, showWarnings = FALSE)
        plot_updated <- FALSE
        null_dev_id <- c(pdf = 2L)
        null_dev_size <- c(7 + pi, 7 + pi)

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
          device = function(...) {
            pdf(NULL,
              width = null_dev_size[[1L]],
              height = null_dev_size[[2L]],
              bg = "white")
            dev.control(displaylist = "enable")
          }
        )
      }



      environment()
    })
    attach(environment(), name = .vsc.name)
  }) else {
    message("VSCode R Session Watcher requires jsonlite.")
    message("Please install it with install.packages(\"jsonlite\").")
  }
}
