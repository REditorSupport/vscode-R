# Retain the resource handles so garbage collection cannot mask missing cleanup.
if (requireNamespace("arrow", quietly = TRUE) &&
      requireNamespace("dbplyr", quietly = TRUE) &&
      requireNamespace("RSQLite", quietly = TRUE)) local({
  env <- sess:::.sess_env
  old_views <- env$dataviews
  old_registry <- env$dataview_registry
  env$dataviews <- list()
  env$dataview_registry <- new.env(parent = emptyenv())
  on.exit({
    sess:::runtime_stop()
    env$dataviews <- old_views
    env$dataview_registry <- old_registry
  }, add = TRUE)
  data <- data.frame(id = seq_len(30000L))

  for (action in c("idle-stop", "active-stop", "disconnect", "restart")) local({
    if (action != "idle-stop") {
      sess:::runtime_start(use_rstudioapi = FALSE, plot_backend = "native")
    }
    con <- DBI::dbConnect(RSQLite::SQLite(), ":memory:")
    unopened_con <- DBI::dbConnect(RSQLite::SQLite(), ":memory:")
    states <- list()
    on.exit({
      for (state in states) {
        sess:::dataview_dbi_result_cache_cleanup(state)
        sess:::dataview_arrow_result_cache_cleanup(state)
      }
      DBI::dbDisconnect(con)
      DBI::dbDisconnect(unopened_con)
      sess:::runtime_stop()
    }, add = TRUE)
    DBI::dbWriteTable(con, "fixture", data)
    table <- dplyr::tbl(con, "fixture")
    # Include a query whose cache exists but whose cursor has not been opened.
    DBI::dbWriteTable(unopened_con, "fixture", data)
    unopened <- sess:::dataview_register(dplyr::tbl(unopened_con, "fixture"))
    states[[1L]] <- sess:::dataview_get_state(unopened$view_id)
    view <- sess:::dataview_register(table)
    states[[2L]] <- sess:::dataview_get_state(view$view_id)
    sess:::handle_dataview_page(list(
      view_id = view$view_id, startRow = 20000L, endRow = 20002L
    ))
    db_cache <- states[[2L]]$dbi_cache
    result <- db_cache$result
    expect_true(DBI::dbIsValid(result))
    expect_false(DBI::dbHasCompleted(result))
    expect_true(length(list.files(db_cache$result_cache_dir)) > 0L)

    view <- sess:::dataview_register(dplyr::filter(arrow::Table$create(data), id > 0L))
    states[[3L]] <- sess:::dataview_get_state(view$view_id)
    arrow_cache <- states[[3L]]$arrow_reader
    # Fixed batches ensure the reader is still open after spilling to disk.
    reader <- arrow::RecordBatchReader$create(batches = lapply(0:5, function(i) {
      arrow::as_record_batch(data[(i * 5000L + 1L):((i + 1L) * 5000L), , drop = FALSE])
    }))
    closed <- FALSE
    arrow_cache$reader <- list(
      read_next_batch = reader$read_next_batch,
      Close = function() {
        closed <<- TRUE
        reader$Close()
      }
    )
    sess:::handle_dataview_page(list(
      view_id = view$view_id, startRow = 20000L, endRow = 20002L
    ))
    expect_false(closed)
    expect_true(length(list.files(arrow_cache$result_cache_dir)) > 0L)
    paths <- c(states[[1L]]$dbi_cache$result_cache_dir,
               db_cache$result_cache_dir, arrow_cache$result_cache_dir)
    # Ordinary viewers have no database or Arrow resources.
    sess:::dataview_register(data.frame(id = 1L))
    assign("table:fixture", view$view_id, envir = env$dataview_registry)

    switch(action,
      "idle-stop" = sess:::runtime_stop(),
      "active-stop" = sess:::runtime_stop(),
      "disconnect" = sess:::.transport_disconnect(silent = TRUE),
      "restart" = sess:::runtime_start(use_rstudioapi = FALSE, plot_backend = "native")
    )

    expect_false(DBI::dbIsValid(result), info = action)
    expect_null(db_cache$result, info = action)
    expect_true(closed, info = action)
    expect_null(arrow_cache$reader, info = action)
    expect_false(any(dir.exists(paths)), info = action)
    expect_length(db_cache$result_cache_blocks, 0L)
    expect_length(arrow_cache$result_cache_batches, 0L)
    expect_length(env$dataviews, 0L)
    expect_length(ls(env$dataview_registry, all.names = TRUE), 0L)
    expect_true(DBI::dbIsValid(con))
    expect_equal(DBI::dbGetQuery(con, "SELECT COUNT(*) AS n FROM fixture")$n, nrow(data))
    # Repeated teardown must also be safe with an empty registry.
    expect_silent(sess:::runtime_stop())
  })
})
