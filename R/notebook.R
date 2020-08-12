local({
  requireNamespace("jsonlite")
  args <- commandArgs(trailingOnly = TRUE)
  exprs <- parse(text = args, keep.source = FALSE)
  env <- new.env()
  for (expr in exprs) {
    eval(expr, env)
  }

  print(ls.str(env))
  while (TRUE) {
    con <- socketConnection(host = "127.0.0.1", port = env$port,
      blocking = TRUE, server = TRUE,
      open = "r+")
    line <- readLines(con, n = 1)
    request <- jsonlite::fromJSON(line)
    cat(sprintf("[%s] %s\n",
      request$time, request$expr))
    expr <- parse(text = request$expr)
    res <- try(eval(expr, globalenv()), silent = TRUE)
    str <- list(
      type = if (inherits(res, "try-error")) "error" else "output",
      result = utils::capture.output(print(res))
    )
    result <- jsonlite::toJSON(str, force = TRUE)
    writeLines(result, con)
    close(con)
  }
})
