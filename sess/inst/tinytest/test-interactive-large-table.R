# Large previews bound copying and printing before registering the full object.
local({
  env <- sess:::.sess_env
  views <- env$dataviews
  revision <- env$dataview_revision
  on.exit({
    env$dataviews <- views
    env$dataview_revision <- revision
  })
  snapshot <- sess:::.interactive_table_snapshot
  register <- sess:::dataview_register
  page <- function(id, ...) sess:::handle_dataview_page(list(view_id = id, ...))

  # Match the reported dimensions without allocating a dense 153 GB dataset.
  n <- 832976871L
  large <- structure(rep(list(seq_len(n)), 23L), names = paste0("x", 1:23),
                     class = "data.frame", row.names = c(NA_integer_, -n))
  small <- snapshot(large)
  expect_identical(small$source_rows, n)
  expect_true(small$truncated)
  expect_identical(dim(small$value), c(1000L, 23L))
  expect_identical(small$value$x1, 1:1000)
  expect_true(as.numeric(object.size(small$value)) < 200000)
  full <- register(large, live = TRUE)$view_id
  expect_identical(page(full, startRow = n - 2L, endRow = n)$rows[["1"]], (n - 1L):n)
  expect_null(env$dataviews[[full]]$query_indices)

  wide <- as.data.frame(rep(list(1:500), 501L))
  wide_snapshot <- snapshot(wide)$value
  expect_true(nrow(wide_snapshot) * ncol(wide_snapshot) <= 100000L)
  expect_identical(snapshot(iris)$value, iris)
  expect_false(snapshot(iris[0, ])$truncated)
  zero_columns <- structure(list(), class = "data.frame", row.names = c(NA_integer_, -2000L))
  expect_identical(dim(snapshot(zero_columns)$value), c(1000L, 0L))

  matrix <- matrix(1:4000, ncol = 2L, dimnames = list(paste0(" ", 1:2000, " "), NULL))
  matrix_id <- register(matrix)$view_id
  expect_identical(env$dataviews[[matrix_id]]$row_index, rownames(matrix))
  expect_identical(page(matrix_id, startRow = 1999L, endRow = 2000L)$rows[["0"]], "2000")

  # A one-row table can still hide gigabytes in a list cell or factor metadata.
  nested <- data.frame(id = 1L)
  nested$payload <- list(large)
  expect_identical(snapshot(nested)$value$payload[[1L]], "<data.frame [832976871 x 23]>")
  expect_identical(page(register(nested)$view_id)$rows[["2"]][[1L]],
                   "<data.frame [832976871 x 23]>")
  nested$payload <- list(seq_len(n))
  expect_identical(snapshot(nested)$value$payload[[1L]], "<integer [832976871]>")
  nested$payload <- I(list(large))
  expect_identical(snapshot(nested)$value$payload[[1L]], "<data.frame [832976871 x 23]>")
  nested$payload <- list(structure(list(data = large), class = "large_model"))
  expect_identical(snapshot(nested)$value$payload[[1L]], "<large_model [1]>")
  nested$payload <- list(list(a = list(b = list(c = seq_len(n)))))
  expect_true(nchar(jsonlite::toJSON(snapshot(nested)$value)) < 200L)
  long_text <- c(NA_character_, "small", strrep("λ", 2000L))
  text <- sess:::dataview_preview_text(long_text)
  expect_identical(text[1:2], long_text[1:2])
  expect_true(nchar(text[[3L]]) < 1020L)
  expect_true(endsWith(text[[3L]], "… [truncated]"))
  long_frame <- data.frame(text = paste0(strrep("a", 2000L), "needle"))
  filtered <- page(register(long_frame)$view_id,
                   filterModel = list("1" = list(type = "contains", filter = "needle")))
  expect_identical(filtered$totalRows, 1L)
  expect_true(endsWith(filtered$rows[["1"]], "… [truncated]"))

  workspace_name <- "large_preview_test"
  assign(workspace_name, setNames(as.list(1:2000), paste0("item", 1:2000)), .GlobalEnv)
  on.exit(rm(list = workspace_name, envir = .GlobalEnv), add = TRUE)
  expect_length(sess:::get_workspace_data()$globalenv[[workspace_name]]$names, 1000L)
  expect_length(sess:::get_workspace_children(workspace_name, start = 1501L)$children, 500L)

  if (requireNamespace("data.table", quietly = TRUE)) {
    dt <- data.table::data.table(id = 1:2000, value = 1:2000)
    saved <- register(snapshot(dt)$value)$view_id
    live <- register(dt, live = TRUE)$view_id
    expect_identical(data.table::address(env$dataviews[[live]]$data), data.table::address(dt))
    query <- list(view_id = live, startRow = 0L, endRow = 2L,
                  sortModel = list(list(colId = "2", sort = "desc")))
    expect_identical(sess:::handle_dataview_page(query)$rows[["2"]], 2000:1999)
    data.table::set(dt, j = "value", value = -seq_len(2000L))
    sess:::.workspace_update_task_callback(schedule = function(...) NULL)
    expect_identical(sess:::handle_dataview_page(query)$rows[["2"]], -1:-2)
    expect_identical(page(saved, startRow = 998L, endRow = 1000L)$rows[["2"]], 999:1000)
    data.table::setnames(dt, "value", "changed")
    expect_error(page(live), "Reopen Data viewer")
    metadata <- sess:::handle_dataview_init(list(view_id = live))
    expect_true(metadata$live)
    expect_identical(as.character(metadata$columns[[3L]]$headerName), "changed")
    expect_identical(page(live, startRow = 0L, endRow = 1L)$rows[["2"]], -1L)
    nested_dt <- data.table::data.table(value = 1:3)
    container <- data.table::data.table(id = 1L, payload = list(nested_dt))
    kept <- snapshot(container)$value
    data.table::set(nested_dt, j = "value", value = 4:6)
    expect_identical(kept$payload[[1L]]$value, 1:3)
    # Snapshotting must not duplicate a factor's arbitrarily large level vector.
    factor <- structure(1:3, levels = as.character(1:1000000), class = "factor")
    factored <- data.table::data.table(value = factor)
    kept <- snapshot(factored)$value
    expect_identical(data.table::address(levels(kept$value)),
                     data.table::address(levels(factored$value)))
  }
})
