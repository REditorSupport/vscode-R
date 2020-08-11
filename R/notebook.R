local({
  requireNamespace("jsonlite")
  port <- 8780
  args <- commandArgs(trailingOnly = TRUE)
  for (arg in args) {
    eval(arg, globalenv())
  }

  while (TRUE) {
    con <- try(socketConnection(host = "127.0.0.1", port = port,
      blocking = TRUE, server = TRUE,
      open = "r+", timeout = 86400L), silent = TRUE)
    if (inherits(con, "try-error")) {
      message(con, "\n")
    } else {
      tryCatch({
        request <- jsonlite::fromJSON(readLines(con, n = 1))
        cat(sprintf("[%s] %s > %s\n",
          request$time,
          request$client, request$expr))
        expr <- parse(text = request$expr)
        res <- try(eval(expr, globalenv()), silent = TRUE)
        str <- list(
          type = if (inherits(res, "try-error")) "error" else "output",
          result = utils::capture.output(print(res))
        )
        writeLines(jsonlite::toJSON(str), con)
      }, error = function(e) message(e, "\n"),
      warning = function(w) message(w, "\n"),
      finally = close(con))
    }
  }
})
