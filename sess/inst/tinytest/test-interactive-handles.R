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
options(sess.dataviewer = "sess")
expect_null(preview(data.frame(a = 1), "table"))
