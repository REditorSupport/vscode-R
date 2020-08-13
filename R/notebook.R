local({
  requireNamespace("jsonlite")
  args <- commandArgs(trailingOnly = TRUE)
  exprs <- parse(text = args, keep.source = FALSE)
  env <- new.env()
  for (expr in exprs) {
    eval(expr, env)
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
          out <- eval(expr, globalenv())
          list(
            type = "output",
            result = paste0(utils::capture.output(print(out)), collapse = "\n")
          )
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
