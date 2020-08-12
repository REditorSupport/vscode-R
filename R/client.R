con <- socketConnection(host = "127.0.0.1", port = 8708,
  blocking = TRUE, server = FALSE, open = "r+")
request <- list(time = format(Sys.time()), expr = "1+1")
json <- jsonlite::toJSON(request, auto_unbox = TRUE)
writeLines(json, con)
response <- readLines(con, n = 1)
response
close(con)
