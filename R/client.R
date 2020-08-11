con <- socketConnection(host = "127.0.0.1", port = 8780, blocking = TRUE,
  server = FALSE, open = "r+", timeout = 86400)
on.exit(close(con))
request <- list(client = "hello", time = format(Sys.time()), expr = "1+1")
json <- jsonlite::toJSON(request, auto_unbox = TRUE)
writeLines(json, con)
response <- readLines(con)
response
