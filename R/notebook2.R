requireNamespace("jsonlite")
requireNamespace("callr")

args <- commandArgs(trailingOnly = TRUE)
exprs <- parse(text = args, keep.source = FALSE)
env <- new.env()
for (expr in exprs) {
  eval(expr, env)
}

r <- callr::r_session$new(
  callr::r_session_options(
    system_profile = TRUE, user_profile = TRUE, supervise = TRUE),
  wait = TRUE
)

r$run(function() {
  requireNamespace("jsonlite")
  requireNamespace("svglite")

  .vscNotebook <- local({
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
        viewer_file <<- url
      },
      page_viewer = function(url, ...) {
        viewer_file <<- url
      },
      browser = function(url, ...) {
        browser_url <<- url
      }
    )

    check_null_dev <- function() {
      identical(dev.cur(), null_dev_id) &&
        identical(dev.size(), null_dev_size)
    }

    evaluate <- function(id, uri, expr) {
      viewer_file <<- NULL
      browser_url <<- NULL
      res <- tryCatch({
        expr <- parse(text = expr)
        out <- withVisible(eval(expr, globalenv()))
        text <- utils::capture.output(print(out$value, view = TRUE))
        if (check_null_dev()) {
          record <- recordPlot()
          plot_file <- tempfile(fileext = ".svg")
          svglite::svglite(plot_file, width = 12, height = 8)
          replayPlot(record)
          graphics.off()
          list(
            type = "plot",
            result = plot_file
          )
        } else if (!is.null(viewer_file)) {
          list(
            type = "viewer",
            result = viewer_file
          )
        } else if (!is.null(browser_url)) {
          list(
            type = "browser",
            result = browser_url
          )
        } else if (out$visible) {
          list(
            type = "text",
            result = paste0(text, collapse = "\n")
          )
        } else {
          list(
            type = "text",
            result = ""
          )
        }
      }, error = function(e) {
        list(
          type  = "error",
          result = conditionMessage(e)
        )
      })

      c(id = id, uri = uri, res)
    }

    environment()
  })

  attach(environment(), name = "tools:vscNotebook")
  NULL
})

con <- socketConnection(host = "127.0.0.1", port = env$port, open = "r+b")

while (TRUE) {
  response <- NULL
  if (socketSelect(list(con), timeout = 0)) {
    header <- readLines(con, 1, encoding = "UTF-8")
    n <- as.integer(gsub("^Content-Length\\: (\\d+)$", "\\1", header))
    content <- readChar(con, n, useBytes = TRUE)
    Encoding(content) <- "UTF-8"
    cat(content, "\n", sep = "")

    request <- jsonlite::fromJSON(content, simplifyVector = FALSE)
    response <- tryCatch({
      r$call(function(id, uri, expr) {
        .vscNotebook$evaluate(id, uri, expr)
      }, request)
      NULL
    }, error = function(e) {
      list(
        id = request$id,
        uri = request$uri,
        type = "error",
        result = conditionMessage(e)
      )
    })
  }

  result <- r$read()
  if (!is.null(result)) {
    if (is.list(result$result)) {
      response <- result$result
    } else if (!is.null(result$error)) {
      message(result$error)
    }
  }

  if (!is.null(response)) {
    response <- jsonlite::toJSON(result$result,
      auto_unbox = TRUE, force = TRUE)
    writeLines(response, con)
  }
  Sys.sleep(0.1)
}
