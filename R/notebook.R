local({
  requireNamespace("jsonlite")
  requireNamespace("svglite")
  args <- commandArgs(trailingOnly = TRUE)
  exprs <- parse(text = args, keep.source = FALSE)
  env <- new.env()
  for (expr in exprs) {
    eval(expr, env)
  }

  null_dev_id <- c(pdf = 2L)
  null_dev_size <- c(7 + pi, 7 + pi)
  viewer_file <- NULL
  browser_url <- NULL

  options(
    device = function(...) {
      pdf(NULL,
        width = null_dev_size[[1L]],
        height = null_dev_size[[2L]],
        bg = "white")
      dev.control(displaylist = "enable")
    },
    viewer = function(url, ...) {
      message("viewer: ", url)
      viewer_file <<- url
    },
    page_viewer = function(url, ...) {
      message("page_viewer: ", url)
      viewer_file <<- url
    },
    browser = function(url, ...) {
      message("browser: ", url)
      browser_url <<- url
    }
  )

  check_null_dev <- function() {
    identical(dev.cur(), null_dev_id) &&
      identical(dev.size(), null_dev_size)
  }

  ls.str(env)
  while (TRUE) {
    con <- try(socketConnection(host = "127.0.0.1", port = env$port,
      blocking = TRUE, server = TRUE,
      open = "r+"), silent = TRUE)
    if (inherits(con, "try-error")) {
      message(con)
    } else {
      tryCatch({
        line <- readLines(con, n = 1)
        request <- jsonlite::fromJSON(line)
        cat(sprintf("[%s]\n%s\n", request$time, request$expr))
        viewer_file <- NULL
        browser_url <- NULL
        str <- tryCatch({
          expr <- parse(text = request$expr)
          out <- withVisible(eval(expr, globalenv()))
          text <- utils::capture.output(print(out$value, view = TRUE))
          if (check_null_dev()) {
            record <- recordPlot()
            plot_file <- tempfile(fileext = ".svg")
            svglite::svglite(plot_file, width = 12, height = 8)
            replayPlot(record)
            graphics.off()
            res <- list(
              type = "plot",
              result = plot_file
            )
          } else if (!is.null(viewer_file)) {
            res <- list(
              type = "viewer",
              result = viewer_file
            )
          } else if (!is.null(browser_url)) {
            res <- list(
              type = "browser",
              result = browser_url
            )
          } else if (out$visible) {
            res <- list(
              type = "text",
              result = paste0(text, collapse = "\n")
            )
          } else {
            res <- list(
              type = "text",
              result = ""
            )
          }
          res
        }, error = function(e) {
            list(
              type = "error",
              result = conditionMessage(e)
            )
          }
        )
        response <- jsonlite::toJSON(str, auto_unbox = TRUE, force = TRUE)
        writeLines(response, con)
      }, error = function(e) {
        message(e)
      }, finally = close(con))
    }
  }
})
