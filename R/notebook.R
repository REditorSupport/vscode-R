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
  wait = TRUE, wait_timeout = 3000
)

r$run(function() {
  requireNamespace("jsonlite")

  .vscNotebook <- local({
    viewer_file <- NULL
    browser_url <- NULL
    plot.new.called <- F

    set_plot_new <- function() {
        plot.new.called <<- T
    }
    setHook("before.plot.new", set_plot_new)
    setHook("before.grid.newpage", set_plot_new)

    options(
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

    evaluate <- function(id, expr) {
      plot_dir <- tempdir()
      plot_file <- file.path(plot_dir, "plot%03d.svg")

      svg(plot_file, width = 12, height = 8)

      viewer_file <<- NULL
      browser_url <<- NULL

      res <- tryCatch({
        expr <- parse(text = expr)
        out <- withVisible(eval(expr, globalenv()))

        text <- utils::capture.output(print(out$value, view = TRUE))

        dev.off()
        graphics.off()

        if (plot.new.called) {
          plot.new.called <<- F

          list(
            id = id,
            type = "plot",
            result = list.files(plot_dir, pattern = ".*\\.svg", full.names = T)
          )
        } else if (!is.null(viewer_file)) {
          list(
            id = id,
            type = "viewer",
            result = viewer_file
          )
        } else if (!is.null(browser_url)) {
          list(
            id = id,
            type = "browser",
            result = browser_url
          )
        } else if (out$visible) {
          if (inherits(out$value, "data.frame")) {
            table <- head(out$value, 10)
            list(
              id = id,
              type = "table",
              result = list(
                html = knitr::kable(table, format = "html"),
                markdown = paste0(knitr::kable(table, format = "markdown"), collapse = "\n"),
                data = head(out$value, 1000)
              )
            )
          } else {
            list(
              id = id,
              type = "text",
              result = paste0(text, collapse = "\n")
            )
          }
        } else {
          list(
            id = id,
            type = "text",
            result = ""
          )
        }
      }, error = function(e) {
        list(
          id = id,
          type  = "error",
          result = conditionMessage(e)
        )
      })

      res
    }

    environment()
  })

  attach(environment(), name = "tools:vscNotebook")
  NULL
})

con <- socketConnection(host = "127.0.0.1", port = env$port, open = "r+b")
running_request <- NULL

while (TRUE) {
  response <- NULL
  if (socketSelect(list(con), timeout = 0)) {
    header <- readLines(con, 1, encoding = "UTF-8")
    n <- as.integer(gsub("^Content-Length\\: (\\d+)$", "\\1", header))
    content <- readChar(con, n, useBytes = TRUE)
    Encoding(content) <- "UTF-8"
    cat(content, "\n", sep = "")

    request <- jsonlite::fromJSON(content, simplifyVector = FALSE)
    if (request$type == "eval") {
      response <- tryCatch({
        r$call(function(id, expr) {
          .vscNotebook$evaluate(id, expr)
        }, list(id = request$id, expr = request$expr))
        running_request <- request
        NULL
      }, error = function(e) {
        list(
          id = request$id,
          type = "error",
          result = conditionMessage(e)
        )
      })
    } else if (request$type == "cancel") {
      r$interrupt()
    }
  }

  if (!is.null(running_request)) {
    result <- r$read()
    if (!is.null(result)) {
      print(result)
      if (is.list(result$result)) {
        response <- result$result
      } else {
        if (is.null(result$error)) {
          response <- list(
            id = running_request$id,
            type = "text",
            result = result$message
          )
        } else {
          response <- list(
            id = running_request$id,
            type = "error",
            result = conditionMessage(result$error)
          )
        }
      }
      running_request <- NULL
    }

    if (!is.null(response)) {
      response <- jsonlite::toJSON(response,
        auto_unbox = TRUE, force = TRUE)
      cat("response: ", response, "\n")
      writeLines(response, con)
    }
  }

  Sys.sleep(0.05)
}
