con <- socketConnection(host = "127.0.0.1", port = 8781, blocking = TRUE,
  server = FALSE, open = "w", timeout = 86400)
on.exit(close(con))
request <- list(time = format(Sys.time()), expr = "1+1")
json <- jsonlite::toJSON(request, auto_unbox = TRUE)
writeLines(json, con)
response <- readLines(con)
response
