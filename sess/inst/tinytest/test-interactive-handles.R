# Inline table and list previews use registry-free jdv handles when jdv is installed.
if (!requireNamespace("jdv", quietly = TRUE)) {
  exit_file("jdv is not installed")
}

ns <- asNamespace("sess")
env <- sess:::.sess_env
previous <- list(handles = env$interactive_handles, order = env$interactive_handle_order,
                 seq = env$interactive_handle_seq)
on.exit({
  ns$.interactive_handle_close_all()
  env$interactive_handles <- previous$handles
  env$interactive_handle_order <- previous$order
  env$interactive_handle_seq <- previous$seq
  options(sess.dataviewer = NULL)
})
options(sess.dataviewer = NULL)
preview <- ns$.interactive_handle_preview
request <- function(id, method, params = list()) {
  jsonlite::fromJSON(ns$handle_jdv_request(list(handle_id = id, method = method,
                                                params = params))$json,
                     simplifyVector = FALSE)
}

# A table yields a descriptor and a bounded first page without using the viewer registry.
table <- preview(data.frame(id = 1:100, name = rep(c("a", "b"), 50)), "table")
expect_true(is.character(table$handleId))
descriptor <- jsonlite::fromJSON(table$descriptor, simplifyVector = FALSE)
expect_identical(descriptor$kind, "grid")
expect_identical(descriptor$access, "random")
expect_identical(descriptor$nrow, 100L)
first <- jsonlite::fromJSON(table$page, simplifyVector = FALSE)
expect_identical(length(first$data$source_row), 20L)
expect_identical(first$total, 100L)
single_event <- jsonlite::fromJSON(jsonlite::toJSON(
  list(page = table$page), auto_unbox = TRUE, null = "null", digits = NA
), simplifyVector = FALSE)
expect_identical(single_event$page, table$page)

# Byte-limited pages stay unchanged and stop before the complete event budget.
numeric <- rep(pi, 150)
numeric[[3L]] <- Inf
wide <- data.frame(
  id = 1:150, text = rep(strrep("a", 100000), 150),
  category = factor(rep(c("a", "b"), 75)), missing = rep(c(NA, "x"), 75),
  numeric = numeric, row.names = paste0("row-", 0:149)
)
wide_preview <- preview(wide, "table")
expect_true(length(wide_preview$page) > 1L)
wide_entry <- ns$.interactive_handle_entry(wide_preview$handleId)
expected_pages <- character()
offset <- 0L
while (length(expected_pages) < length(wide_preview$page)) {
  raw_page <- jdv::jdv_handle_request(
    wide_entry$handle, "grid/rows", list(offset = offset, limit = 20L - offset),
    max_bytes = ns$.interactive_page_bytes
  )
  expected_pages <- c(expected_pages, raw_page)
  parsed_page <- jsonlite::fromJSON(raw_page, simplifyVector = FALSE)
  returned <- length(parsed_page$data$source_row)
  if (returned == 0L) break
  offset <- offset + returned
}
expect_identical(wide_preview$page, expected_pages)
multi_event <- jsonlite::fromJSON(jsonlite::toJSON(
  list(page = wide_preview$page), auto_unbox = TRUE, null = "null", digits = NA
), simplifyVector = FALSE)
expect_identical(unlist(multi_event$page), expected_pages)
wide_pages <- lapply(wide_preview$page, jsonlite::fromJSON, simplifyVector = FALSE)
wide_rows <- unlist(lapply(wide_pages, function(page) page$data$source_row))
expect_true(length(wide_rows) < 20L)
expect_identical(wide_rows, seq_along(wide_rows) - 1L)
factor_values <- sum(vapply(wide_pages, function(page) {
  length(page$data$columns[[3L]]$data$values)
}, 0L))
missing_values <- unlist(lapply(wide_pages, function(page) page$data$columns[[4L]]$data$na))
row_labels <- unlist(lapply(wide_pages, function(page) page$data$row_labels))
empty_errors <- vapply(wide_pages, function(page) {
  identical(names(page$data$columns[[1L]]$errors), character())
}, logical(1L))
expect_identical(factor_values, length(wide_rows))
expect_identical(missing_values, rep(c(TRUE, FALSE), length.out = length(wide_rows)))
expect_identical(row_labels, paste0("row-", wide_rows))
expect_true(all(empty_errors))

# Capture the actual display event, including printed text and JSON escaping.
local({
  original_send <- ns$rpc_send
  fields <- c("interactive_pid", "interactive_id", "interactive_managed")
  saved <- mget(fields, env, ifnotfound = list(NULL))
  captured <- NULL
  unlockBinding("rpc_send", ns)
  assign("rpc_send", function(method, params) captured <<- params, envir = ns)
  lockBinding("rpc_send", ns)
  on.exit({
    unlockBinding("rpc_send", ns)
    assign("rpc_send", original_send, envir = ns)
    lockBinding("rpc_send", ns)
    list2env(saved, env)
  }, add = TRUE)
  env$interactive_pid <- Sys.getpid()
  env$interactive_id <- "preview-budget"
  env$interactive_managed <- FALSE
  expect_true(ns$.interactive_rich_value(wide))
  expect_identical(captured$type, "display")
  expect_identical(captured$kind, "table")
  encoded <- jsonlite::toJSON(captured, auto_unbox = TRUE, null = "null", digits = NA)
  expect_true(nchar(encoded, type = "bytes") <= ns$.interactive_preview_bytes)
  expect_true(is.character(captured$handleId))

  # The printed fallback can be omitted; a valid table with no inline rows is OK.
  oversized <- preview(wide, "table", list(printedText = strrep("x", 2L * 1024L * 1024L)))
  expect_null(oversized$printedText)
  empty <- preview(wide, "table", list(printedText = strrep("x", 1530L * 1024L)))
  expect_identical(length(empty$page), 0L)
  ns$.interactive_event("display", c(list(kind = "table"), empty))
  expect_identical(captured$type, "display")
  empty_json <- ns$.interactive_event_json("display", empty)
  expect_true(nchar(empty_json, type = "bytes") < 2L * 1024L * 1024L)

  # The last-resort truncation path releases the captured handle.
  ns$.interactive_event("display", c(list(kind = "table"), empty,
                                     list(extra = strrep("x", 2L * 1024L * 1024L))))
  expect_identical(captured$type, "truncated")
  expect_error(ns$.interactive_handle_entry(empty$handleId), "no longer available")
})

# Paging, sorting and filtering run in R through the same handle; ids are zero-based rows.
sorted <- request(table$handleId, "grid/rows", list(
  offset = 0L, limit = 3L, sort = list(list(col = 0L, desc = TRUE)),
  filter = list(op = "text_equals", col = 1L, value = "a")
))
expect_identical(sorted$total, 50L)
expect_identical(unlist(sorted$data$source_row), c(98L, 96L, 94L))

# A list yields a tree descriptor and its first children page.
tree <- preview(list(a = 1, b = data.frame(z = 1:2), 3), "list")
expect_identical(jsonlite::fromJSON(tree$descriptor, simplifyVector = FALSE)$kind, "tree")
children <- jsonlite::fromJSON(tree$page, simplifyVector = FALSE)
expect_identical(vapply(children$children, function(child) child$label, ""), c("a", "b", ""))
expect_identical(request(tree$handleId, "object/children", list(
  path = list(list(type = "index", index = 2L)), offset = 0L, limit = 10L, attributes = FALSE
))$total_children, 1L)

# Opening an Interactive handle registers the selected value through jdv's handle API.
# The custom [[ method must not run while opening a nested table.
local({
  started_session <- identical(jdv::jdv_connection()$state, "disconnected")
  original_connect <- ns$.jdv_connect
  review_handle_id <- NULL
  registered_views <- list()
  unlockBinding(".jdv_connect", ns)
  assign(".jdv_connect", function(address = NULL) TRUE, envir = ns)
  lockBinding(".jdv_connect", ns)
  on.exit({
    if (!is.null(review_handle_id)) {
      ns$handle_jdv_handle_close(list(handle_id = review_handle_id))
    }
    for (view in registered_views) {
      try(jdv::jdv_rpc(jsonlite::toJSON(list(
        id = 1L, method = "view/close",
        params = list(view = view$id, generation = view$generation)
      ), auto_unbox = TRUE)), silent = TRUE)
    }
    jdv::jdv_notifications()
    if (started_session) jdv::jdv_disconnect()
    unlockBinding(".jdv_connect", ns)
    assign(".jdv_connect", original_connect, envir = ns)
    lockBinding(".jdv_connect", ns)
  }, add = TRUE)

  anchor <- jdv::jdv_register(data.frame(anchor = 1L), title = "interactive handles test anchor")
  registered_views <- list(anchor)
  jdv::jdv_notifications()
  method_calls <- 0L
  previous_method <- if (exists("[[.review_list", envir = .GlobalEnv, inherits = FALSE)) {
    get("[[.review_list", envir = .GlobalEnv, inherits = FALSE)
  }
  assign("[[.review_list", function(x, i, ...) {
    method_calls <<- method_calls + 1L
    stop("review_list [[ method must not be called")
  }, envir = .GlobalEnv)
  on.exit({
    if (is.null(previous_method)) {
      if (exists("[[.review_list", envir = .GlobalEnv, inherits = FALSE)) {
        rm("[[.review_list", envir = .GlobalEnv)
      }
    } else {
      assign("[[.review_list", previous_method, envir = .GlobalEnv)
    }
  }, add = TRUE)
  review <- structure(list(table = data.frame(z = 1:2)), class = "review_list")
  review_preview <- preview(review, "list")
  review_handle_id <- review_preview$handleId
  expect_true(!is.null(review_preview))

  opens <- function() {
    messages <- lapply(jdv::jdv_notifications(), jsonlite::fromJSON,
                       simplifyVector = FALSE)
    result <- Filter(function(message) identical(message$method, "view/open"), messages)
    registered_views <<- c(registered_views, lapply(result, function(message) {
      list(id = message$params$view, generation = message$params$generation)
    }))
    result
  }
  opened <- function() lapply(opens(), `[[`, "params")
  request <- function(method, params) {
    parsed <- jsonlite::fromJSON(jdv::jdv_rpc(jsonlite::toJSON(
      list(id = 1L, method = method, params = params), auto_unbox = TRUE
    )), simplifyVector = FALSE)
    parsed$result
  }

  expect_true(ns$handle_jdv_open_viewer(list(
    handle_id = review_preview$handleId,
    path = list(list(type = "index", index = 1L)),
    title = "Cell: List$table"
  )))
  child <- opened()[[1L]]
  expect_identical(child$kind, "grid")
  expect_identical(child$title, "Cell: List$table")
  rows <- request("grid/rows", list(view = child$view, generation = child$generation,
                                    offset = 0L, limit = 2L))
  expect_identical(length(rows$data$source_row), 2L)
  expect_identical(method_calls, 0L)

  # Empty paths register the root handle itself; named titles retain refresh behavior.
  expect_true(ns$handle_jdv_open_viewer(list(
    handle_id = review_preview$handleId, path = list(), title = "Interactive root"
  )))
  root_first <- opened()[[1L]]
  expect_identical(root_first$kind, "tree")
  expect_identical(root_first$title, "Interactive root")
  expect_true(ns$handle_jdv_open_viewer(list(
    handle_id = review_preview$handleId, path = list(), title = "Interactive root"
  )))
  root_refresh <- opened()[[1L]]
  expect_identical(root_refresh$view, root_first$view)
  expect_identical(root_refresh$generation, root_first$generation + 1L)

  # Empty titles remain independent even though jdv handles carry their own fallback title.
  expect_true(ns$handle_jdv_open_viewer(list(
    handle_id = review_preview$handleId, path = list(), title = ""
  )))
  expect_true(ns$handle_jdv_open_viewer(list(
    handle_id = review_preview$handleId, path = list(), title = ""
  )))
  untitled <- opened()
  expect_identical(length(untitled), 2L)
  expect_true(all(vapply(untitled, function(view) startsWith(view$title, "Interactive output "),
                         logical(1L))))
  expect_false(identical(untitled[[1L]]$view, untitled[[2L]]$view))

  expect_false(ns$handle_jdv_open_viewer(list(
    handle_id = review_preview$handleId,
    path = list(list(type = "index", index = 99L)), title = "invalid path"
  )))
  unlockBinding(".jdv_connect", ns)
  assign(".jdv_connect", function(address = NULL) FALSE, envir = ns)
  lockBinding(".jdv_connect", ns)
  expect_false(ns$handle_jdv_open_viewer(list(
    handle_id = review_preview$handleId, path = list(), title = "disconnected"
  )))
  expect_true(ns$handle_jdv_handle_close(list(handle_id = review_preview$handleId)))
  rows_after_handle_close <- request(
    "grid/rows", list(view = child$view, generation = child$generation, offset = 0L, limit = 2L)
  )
  expect_identical(length(rows_after_handle_close$data$source_row), 2L)
})

# Only grid rows and object children can be requested.
expect_error(ns$handle_jdv_request(list(handle_id = table$handleId, method = "view/close")),
             "Unsupported")

# Closing releases the handle, idempotently; unknown ids report that the data is gone.
expect_true(ns$handle_jdv_handle_close(list(handle_id = table$handleId)))
expect_true(ns$handle_jdv_handle_close(list(handle_id = table$handleId)))
expect_error(request(table$handleId, "grid/rows"), "no longer available")

# The number of live handles is bounded; the oldest are closed first.
ns$.interactive_handle_close_all()
ids <- vapply(seq_len(ns$.interactive_handle_limit + 3L), function(i) {
  preview(list(i), "list")$handleId
}, "")
expect_identical(length(env$interactive_handle_order), ns$.interactive_handle_limit)
expect_error(request(ids[[1L]], "object/children"), "no longer available")
expect_silent(request(ids[[length(ids)]], "object/children", list(path = list())))

# Values jdv cannot represent, or an opt-out, leave the dataview registry in charge.
expect_null(preview(quote(x), "list"))
expect_null(preview(data.frame(text = strrep("a", 300000)), "table"))
options(sess.dataviewer = "sess")
expect_null(preview(data.frame(a = 1), "table"))
