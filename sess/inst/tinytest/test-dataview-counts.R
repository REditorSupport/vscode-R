if (requireNamespace("arrow", quietly = TRUE) &&
      requireNamespace("dbplyr", quietly = TRUE) &&
      requireNamespace("RSQLite", quietly = TRUE)) local({
  con <- DBI::dbConnect(RSQLite::SQLite(), ":memory:")
  path <- tempfile(fileext = ".parquet")
  views <- list()
  on.exit({
    for (view in views) sess:::handle_dataview_dispose(view)
    DBI::dbDisconnect(con)
    unlink(path)
  }, add = TRUE)

  for (n in c(0L, 10L, 500L, 12010L)) {
    data <- data.frame(id = seq_len(n))
    DBI::dbWriteTable(con, "fixture", data, overwrite = TRUE)
    arrow::write_parquet(data, path, chunk_size = 5000L)
    table <- dplyr::tbl(con, "fixture")
    sources <- list(
      arrow = dplyr::filter(arrow::open_dataset(path), id > 0L),
      database_table = table,
      database_query = dplyr::filter(table, id > 0L)
    )
    for (backend in names(sources)) {
      view <- sess:::dataview_register(sources[[backend]])
      views[[length(views) + 1L]] <- view
      init <- sess:::handle_dataview_init(list(view_id = view$view_id))
      expect_null(init$totalRows, info = backend)
      first <- sess:::handle_dataview_page(list(
        view_id = view$view_id, startRow = 0L, endRow = if (n > 500L) 5000L else 500L
      ))
      if (n <= 500L) {
        expect_equal(first$totalRows, n, info = backend)
        expect_equal(first$lastRow, n, info = backend)
        expect_null(first$fetchedRows, info = backend)
      } else {
        expect_equal(first$lastRow, -1L, info = backend)
        expect_null(first$totalRows, info = backend)
        expect_null(first$totalUnfiltered, info = backend)
        cache <- sess:::dataview_lazy_cache(sess:::dataview_get_state(view$view_id))
        expect_equal(first$fetchedRows, cache$result_cache_rows, info = backend)
        expect_true(first$fetchedRows >= 5000L, info = backend)
        expect_true(first$fetchedRows < n, info = backend)
        expect_false(cache$result_complete, info = backend)
        second <- sess:::handle_dataview_page(list(
          view_id = view$view_id, startRow = 5000L, endRow = 5500L, fields = "0"
        ))
        expect_true(second$fetchedRows >= first$fetchedRows, info = backend)
        expect_equal(second$fetchedRows, cache$result_cache_rows, info = backend)
        backward <- sess:::handle_dataview_page(list(
          view_id = view$view_id, startRow = 0L, endRow = 2L
        ))
        expect_equal(backward$fetchedRows, second$fetchedRows, info = backend)
        last <- sess:::handle_dataview_page(list(
          view_id = view$view_id, startRow = 12000L, endRow = 12500L
        ))
        expect_equal(last$totalRows, n, info = backend)
        expect_equal(last$totalUnfiltered, n, info = backend)
        expect_equal(last$lastRow, n, info = backend)
        expect_null(last$fetchedRows, info = backend)
        expect_equal(nrow(last$rows), 10L, info = backend)
      }
      sess:::handle_dataview_dispose(view)
    }
    # Existing eager table responses retain exact totals and no estimate.
    view <- sess:::dataview_register(data)
    views[[length(views) + 1L]] <- view
    expect_equal(sess:::handle_dataview_init(list(view_id = view$view_id))$totalRows, n)
    page <- sess:::handle_dataview_page(list(
      view_id = view$view_id, startRow = 0L, endRow = 500L
    ))
    expect_equal(page$totalRows, n)
    expect_equal(page$lastRow, n)
    expect_null(page$fetchedRows)
    sess:::handle_dataview_dispose(view)
  }
})
