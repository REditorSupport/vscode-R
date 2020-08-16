local({
  requireNamespace("jsonlite")
  args <- commandArgs(trailingOnly = TRUE)
  exprs <- parse(text = args, keep.source = FALSE)
  env <- new.env()
  for (expr in exprs) {
    eval(expr, env)
  }

  plot_file <- file.path(tempdir(), "plot.png")
  null_dev_id <- c(pdf = 2L)
  null_dev_size <- c(7 + pi, 7 + pi)

  options(
    device = function(...) {
      pdf(NULL,
        width = null_dev_size[[1L]],
        height = null_dev_size[[2L]],
        bg = "white")
      dev.control(displaylist = "enable")
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
        str <- tryCatch({
          expr <- parse(text = request$expr)
          out <- withVisible(eval(expr, globalenv()))
          if (check_null_dev()) {
            record <- recordPlot()
            png(filename = plot_file)
            replayPlot(record)
            dev.off()
            dev.off()
            res <- list(
              type = "plot",
              result = plot_file
            )
          } else if (out$visible) {
            print_text <- utils::capture.output(print(out$value))
            res <- list(
              type = "text",
              result = paste0(print_text, collapse = "\n")
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
