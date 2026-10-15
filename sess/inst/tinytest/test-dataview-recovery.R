# These regressions use actual Arrow execution and the public View() hook.
if (requireNamespace("arrow", quietly = TRUE) &&
      requireNamespace("dplyr", quietly = TRUE)) local({
  paths <- character()
  views <- list()
  on.exit({
    for (view in views) sess:::handle_dataview_dispose(view)
    unlink(paths)
  }, add = TRUE)
  dataset <- function(data) {
    path <- tempfile(fileext = ".parquet")
    paths <<- c(paths, path)
    arrow::write_parquet(data, path, chunk_size = 5000L)
    arrow::open_dataset(path)
  }
  register <- function(data, ...) {
    view <- sess:::dataview_register(data, ...)
    views[[length(views) + 1L]] <<- view
    view
  }
  page <- function(view, start = 0L, fields = NULL, sort = list()) {
    sess:::handle_dataview_page(list(
      view_id = view$view_id, startRow = start, endRow = start + 2L,
      fields = fields, sortModel = sort
    ))
  }
  descending <- list(list(colId = "1", sort = "desc"))
  df <- data.frame(id = 1:30000, text = as.character(1:30000))
  df$text[[25001L]] <- "oops"
  query <- dplyr::mutate(dataset(df), number = as.integer(text))
  view <- register(query)
  cache <- sess:::dataview_get_state(view$view_id)$arrow_reader
  for (attempt in 1:2) {
    # Previously the second request succeeded with a false total of 25000.
    expect_error(page(view, sort = descending), "Failed to parse string")
    expect_false(cache$result_complete)
    expect_equal(cache$result_cache_rows, 0L)
    expect_null(cache$reader)
    expect_null(cache$result_query_key)
    expect_null(cache$result_query_indices)
    expect_length(list.files(cache$result_cache_dir), 0L)
  }

  # Cancellation and transient errors must restart from row one without mixing
  # executions, and must remove any previously spilled blocks.
  df$text[[25001L]] <- "25001"
  query <- dplyr::mutate(dataset(df), number = as.integer(text))
  for (condition in c("error", "interrupt")) {
    view <- register(query)
    state <- sess:::dataview_get_state(view$view_id)
    cache <- state$arrow_reader
    sess:::dataview_arrow_result_cache_slice(state, 25000L)
    expect_true(length(list.files(cache$result_cache_dir)) > 0L)
    reader <- cache$reader
    cache$reader <- list(
      read_next_batch = function() {
        stop(structure(
          list(message = "injected read failure", call = NULL),
          class = c(condition, "condition")
        ))
      },
      Close = reader$Close
    )
    caught <- tryCatch(page(view, sort = descending),
                       error = identity, interrupt = identity)
    expect_true(inherits(caught, condition))
    expect_equal(cache$result_cache_rows, 0L)
    expect_length(list.files(cache$result_cache_dir), 0L)
    result <- page(view, sort = descending)
    expect_equal(result$totalRows, 30000L)
    expect_identical(result$rows[["1"]], 30000:29999)
    expect_identical(page(view)$rows[["1"]], 1:2)
  }

  # A struct contributes multiple Parquet leaves. Scalars following it must
  # remain available on distant reads and when only that scalar is projected.
  df <- data.frame(id = 1:20000)
  df$nested <- data.frame(a = 1:20000, b = 20001:40000)
  df$text <- as.character(df$id)
  source <- dataset(df)
  view <- register(source)
  reference <- register(df)
  for (fields in list(NULL, "3", c("2", "3"))) {
    for (start in c(0L, 15000L, 10000L, 0L)) {
      actual <- page(view, start, fields)$rows
      expected <- page(reference, start)$rows
      if (!is.null(fields)) expected <- expected[, c("0", fields), drop = FALSE]
      expect_equal(actual, expected)
    }
  }
  projected <- register(source$WithSchema(source$schema[c("id", "text")]))
  expect_identical(page(projected, 15000L)$rows[["2"]], as.character(15001:15002))
})

if (requireNamespace("arrow", quietly = TRUE) &&
      requireNamespace("dplyr", quietly = TRUE)) local({
  env <- sess:::.sess_env
  old_interactive <- env$interactive_connected
  name <- "sess_review_aggregate_query"
  on.exit({
    env$interactive_connected <- old_interactive
    sess:::runtime_stop()
    rm(list = name, envir = .GlobalEnv)
  }, add = TRUE)
  sess:::runtime_start(use_rstudioapi = FALSE, plot_backend = "native")
  query <- arrow::Table$create(data.frame(id = 1:10, k = rep(1:2, 5))) |>
    dplyr::group_by(k) |>
    dplyr::summarise(n = dplyr::n())
  expect_true(is.na(nrow(query)))
  assign(name, query, envir = .GlobalEnv)
  invisible(sess:::get_workspace_data())
  expect_true(is.na(get(name, env$workspace_dimensions)$dim[[1L]]))
  for (interactive in c(FALSE, TRUE)) {
    env$interactive_connected <- interactive
    utils::View(query, title = name)
    id <- get(paste0("table:", name), env$dataview_registry)
    metadata <- sess:::handle_dataview_init(list(view_id = id))
    expect_null(metadata$totalRows)
    result <- sess:::handle_dataview_page(list(view_id = id, startRow = 0L, endRow = 10L))
    expect_equal(result$totalRows, 2L)
    expect_identical(sort(result$rows[["1"]]), 1:2)
    expect_equal(as.numeric(result$rows[["2"]]), c(5, 5))
  }
  # The same route applies to dbplyr queries: no eager snapshot or row count.
  if (requireNamespace("dbplyr", quietly = TRUE)) {
    db_query <- dbplyr::tbl_lazy(data.frame(id = 1L), con = dbplyr::simulate_mssql())
    class(db_query) <- c("tbl_sql", class(db_query))
    expect_false(sess:::.interactive_rich_value(db_query))
  }
})
