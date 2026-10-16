# View() uses jdv when it is installed and relays the jdv protocol through jdv_rpc.
if (!requireNamespace("jdv", quietly = TRUE)) {
  exit_file("jdv is not installed")
}

local({
  runtime <- sess:::.sess_env
  previous_con <- runtime$con
  previous_plot_path <- runtime$latest_plot_path
  pipe <- processx::conn_create_pipepair()
  on.exit({
    sess:::runtime_stop()
    runtime$con <- previous_con
    runtime$latest_plot_path <- previous_plot_path
    jdv::jdv_close()
    lapply(pipe, close)
  }, add = TRUE)
  runtime$con <- pipe[[2L]]
  # The standard plot backend needs the path that connect() normally sets.
  if (is.null(runtime$latest_plot_path)) runtime$latest_plot_path <- tempfile(fileext = ".png")
  options(sess.dataviewer = NULL)
  sess:::runtime_start(use_rstudioapi = FALSE, plot_backend = "standard")

  read_messages <- function() {
    messages <- strsplit(processx::conn_read_chars(pipe[[1L]]), "\n", fixed = TRUE)[[1L]]
    lapply(messages[nzchar(messages)], jsonlite::fromJSON, simplifyVector = FALSE)
  }
  last_view <- function() {
    views <- Filter(function(message) identical(message$method, "dataview"), read_messages())
    expect_length(views, 1L)
    views[[1L]]$params
  }
  jdv_request <- function(method, params) {
    request <- as.character(jsonlite::toJSON(
      list(id = "jdv-test", method = method, params = params), auto_unbox = TRUE
    ))
    sess:::dispatch_message(as.character(jsonlite::toJSON(
      list(jsonrpc = "2.0", id = "sess-test", method = "jdv_rpc", params = list(request = request)),
      auto_unbox = TRUE
    )))
    replies <- Filter(function(message) identical(message$id, "sess-test"), read_messages())
    expect_length(replies, 1L)
    expect_null(replies[[1L]]$error)
    jsonlite::fromJSON(replies[[1L]]$result, simplifyVector = FALSE)
  }

  sample <- data.frame(x = c(2, 1, NA), y = c("b", "a", "c"))
  utils::View(sample)
  params <- last_view()
  expect_identical(params$source, "jdv")
  expect_identical(params$title, "sample")
  open <- jsonlite::fromJSON(params$open, simplifyVector = FALSE)$params
  expect_identical(open$kind, "grid")
  expect_identical(open$access, "random")
  expect_identical(open$generation, 1L)

  # Rows are computed in R with jdv sorting.
  response <- jdv_request("table/rows", list(
    view = open$view, generation = 1L, offset = 0L, limit = 10L,
    sort = list(list(col = 0L, desc = FALSE))
  ))
  expect_identical(unlist(response$result$data$row_index), c(2L, 1L, 3L))

  # The same title replaces the view and increments its generation.
  utils::View(sample)
  reopened <- jsonlite::fromJSON(last_view()$open, simplifyVector = FALSE)$params
  expect_identical(reopened$view, open$view)
  expect_identical(reopened$generation, 2L)
  stale <- jdv_request("table/rows", list(view = open$view, generation = 1L))
  expect_identical(stale$error$code, "stale_generation")

  # Lists open as trees; tables inside them open as paged child views.
  nested <- list(a = 1:3, df = sample)
  utils::View(nested)
  tree <- jsonlite::fromJSON(last_view()$open, simplifyVector = FALSE)$params
  expect_identical(tree$kind, "tree")
  children <- jdv_request("object/children", list(view = tree$view, generation = 1L, path = list()))
  expect_identical(children$result$children[[2L]]$label, "df")
  child <- jdv_request("object/open", list(
    view = tree$view, generation = 1L, path = children$result$children[[2L]]$path
  ))
  expect_identical(child$result$kind, "grid")
  expect_identical(child$result$access, "random")
  expect_identical(child$result$parent, tree$view)

  closed <- jdv_request("view/close", list(view = open$view, generation = 2L))
  expect_true(closed$result$closed)

  # Arrow data and the explicit opt-out keep the sess data viewer.
  options(sess.dataviewer = "sess")
  utils::View(sample)
  expect_identical(last_view()$source, "table")
  arrow_like <- structure(list(), class = "polars_data_frame")
  expect_true(sess:::.jdv_is_arrow(arrow_like))
  expect_false(sess:::.jdv_show_arrow(arrow_like, "arrow"))
  options(sess.dataviewer = NULL)
  # Arrow data never goes through the jdv_rpc relay, which cannot carry Arrow IPC.
  expect_false(sess:::.dataview_use_jdv(arrow_like))
})
