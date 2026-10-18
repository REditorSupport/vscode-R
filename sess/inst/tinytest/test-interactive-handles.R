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

# A byte-limited page is refilled so the renderer can advance by its page size
# without skipping rows.
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
while (offset < 20L) {
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
expect_identical(wide_rows, 0:19)
factor_values <- sum(vapply(wide_pages, function(page) {
  length(page$data$columns[[3L]]$data$values)
}, 0L))
missing_values <- unlist(lapply(wide_pages, function(page) page$data$columns[[4L]]$data$na))
row_labels <- unlist(lapply(wide_pages, function(page) page$data$row_labels))
empty_errors <- vapply(wide_pages, function(page) {
  identical(names(page$data$columns[[1L]]$errors), character())
}, logical(1L))
expect_identical(factor_values, 20L)
expect_identical(missing_values, rep(c(TRUE, FALSE), 10L))
expect_identical(row_labels, paste0("row-", 0:19))
expect_true(all(empty_errors))

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

# The viewer opens the output's value or one typed item of it.
entry <- ns$.interactive_handle_entry(tree$handleId)
expect_identical(ns$.interactive_resolve_path(entry$value, list(list(type = "index", index = 2L))),
                 data.frame(z = 1:2))
expect_identical(ns$.interactive_resolve_path(entry$value, list()), entry$value)

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
