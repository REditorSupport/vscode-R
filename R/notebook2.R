requireNamespace("jsonlite")
requireNamespace("callr")

args <- commandArgs(trailingOnly = TRUE)
exprs <- parse(text = args, keep.source = FALSE)
env <- new.env()
for (expr in exprs) {
  eval(expr, env)
}

# r <- callr::r_session$new(
#   callr::r_session_options(
#     system_profile = TRUE, user_profile = TRUE, supervise = TRUE),
#   wait = TRUE
# )

# r$run(function() {
#   requireNamespace("jsonlite")
#   requireNamespace("svglite")

#   .vscNotebook <- local({
#     null_dev_id <- c(pdf = 2L)
#     null_dev_size <- c(7 + pi, 7 + pi)
#     viewer_file <- NULL
#     browser_url <- NULL

#     options(
#       device = function(...) {
#         pdf(NULL,
#           width = null_dev_size[[1L]],
#           height = null_dev_size[[2L]],
#           bg = "white")
#         dev.control(displaylist = "enable")
#       },
#       viewer = function(url, ...) {
#         write_log("viewer: ", url)
#         viewer_file <<- url
#       },
#       page_viewer = function(url, ...) {
#         write_log("page_viewer: ", url)
#         viewer_file <<- url
#       },
#       browser = function(url, ...) {
#         write_log("browser: ", url)
#         browser_url <<- url
#       }
#     )

#     check_null_dev <- function() {
#       identical(dev.cur(), null_dev_id) &&
#         identical(dev.size(), null_dev_size)
#     }

#     evaluate <- function(expr) {
#       tryCatch({
#         out <- withVisible(eval(expr, globalenv()))
#         text <- utils::capture.output(print(out$value, view = TRUE))
#         if (check_null_dev()) {
#           record <- recordPlot()
#           plot_file <- tempfile(fileext = ".svg")
#           svglite::svglite(plot_file, width = 12, height = 8)
#           replayPlot(record)
#           graphics.off()
#           res <- list(
#             type = "plot",
#             result = plot_file
#           )
#         } else if (!is.null(viewer_file)) {
#           res <- list(
#             type = "viewer",
#             result = viewer_file
#           )
#         } else if (!is.null(browser_url)) {
#           res <- list(
#             type = "browser",
#             result = browser_url
#           )
#         } else if (out$visible) {
#           res <- list(
#             type = "text",
#             result = paste0(text, collapse = "\n")
#           )
#         } else {
#           res <- list(
#             type = "text",
#             result = ""
#           )
#         }
#       })

#       res
#     }

#     environment()
#   })

#   attach(environment(), name = "tools:vscNotebook")
#   NULL
# })

con <- socketConnection(host = "127.0.0.1", port = env$port, open = "r+b")

request_id <- 0L
while (TRUE) {
  if (socketSelect(list(con), timeout = 0)) {
    header <- readLines(con, 1, encoding = "UTF-8")
    n <- as.integer(gsub("^Content-Length\\: (\\d+)$", "\\1", header))
    content <- readChar(con, n, useBytes = TRUE)
    Encoding(content) <- "UTF-8"
    cat("request ", request_id, ": ", content, "\n", sep = "")
    request_id <- request_id + 1L
  }
  Sys.sleep(0.1)
}

# while (TRUE) {
#   write_log("Listening on port: ", env$port)
#   con <- try(socketConnection(host = "127.0.0.1", port = env$port,
#     blocking = TRUE, server = TRUE,
#     open = "r+"), silent = TRUE)
#   if (inherits(con, "try-error")) {
#     message(con)
#   } else {
#     tryCatch({
#       line <- readLines(con, n = 1)
#       write_log(line)
#       request <- jsonlite::fromJSON(line)

#       str <- tryCatch({
#         expr <- parse(text = request$expr)
#       }, error = function(e) {
#         list(
#           type = "error",
#           result = conditionMessage(e)
#         )
#       }
#       )
#       response <- jsonlite::toJSON(str, auto_unbox = TRUE, force = TRUE)
#       writeLines(response, con)
#     }, error = function(e) {
#       message(e)
#     }, finally = close(con))
#   }
# }
