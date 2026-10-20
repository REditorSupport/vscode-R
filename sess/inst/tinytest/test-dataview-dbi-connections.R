# Each viewer reserves its connection, including before its first page is fetched.
if (requireNamespace("RSQLite", quietly = TRUE) &&
      requireNamespace("arrow", quietly = TRUE) &&
      requireNamespace("dbplyr", quietly = TRUE)) local({
  con <- DBI::dbConnect(RSQLite::SQLite(), ":memory:")
  other <- DBI::dbConnect(RSQLite::SQLite(), ":memory:")
  views <- list()
  on.exit({
    for (view in views) sess:::handle_dataview_dispose(view)
    DBI::dbDisconnect(con)
    DBI::dbDisconnect(other)
  }, add = TRUE)
  fixture <- data.frame(id = seq_len(25010L))
  DBI::dbWriteTable(con, "items", fixture, temporary = TRUE)
  DBI::dbWriteTable(other, "items", data.frame(id = fixture$id + 100000L), temporary = TRUE)
  table <- dplyr::tbl(con, "items")
  ascending <- dplyr::arrange(table, id)
  descending <- dplyr::arrange(table, dplyr::desc(id))
  other_query <- dplyr::arrange(dplyr::tbl(other, "items"), dplyr::desc(id))
  page <- function(view, start = 0L, end = start + 2L) {
    sess:::handle_dataview_page(list(
      view_id = view$view_id, startRow = start, endRow = end
    ))
  }

  a <- sess:::dataview_register(ascending)
  views <- c(views, list(a))
  expect_error(sess:::dataview_register(descending), "separate connection")
  first <- page(a)
  expect_identical(first$rows[["1"]], 1:2)
  expect_equal(first$fetchedRows, 5000L)
  expect_equal(first$lastRow, -1L)
  state <- sess:::dataview_get_state(a$view_id)
  result <- state$dbi_cache$result
  expect_error(sess:::dataview_register(descending), "separate connection")
  expect_true(DBI::dbIsValid(result))
  expect_identical(state$dbi_cache$result, result)
  expect_identical(page(a)$rows, first$rows)

  # Identical table names and SQL must not share data across connections.
  expect_identical(DBI::dbGetInfo(con), DBI::dbGetInfo(other))
  b <- sess:::dataview_register(other_query)
  views <- c(views, list(b))
  first_other <- page(b)
  expect_identical(first_other$rows[["1"]], 125010:125009)
  expect_equal(first_other$fetchedRows, 5000L)

  # Interleave requests past the first batch, then revisit both cached prefixes.
  expect_identical(page(a, 6000L)$rows[["1"]], 6001:6002)
  expect_identical(page(b, 6000L)$rows[["1"]], 119010:119009)
  expect_identical(page(a)$rows[["1"]], 1:2)
  expect_identical(page(b)$rows[["1"]], 125010:125009)
  expect_identical(page(a, 12000L)$rows[["1"]], 12001:12002)
  expect_identical(page(b, 12000L)$rows[["1"]], 113010:113009)

  # Finishing and disposing one viewer must leave the other viewer and the
  # user's connection usable, including data read back from spilled blocks.
  last <- page(a, 25000L, 25020L)
  expect_identical(last$rows[["1"]], 25001:25010)
  expect_equal(last$totalRows, 25010L)
  cache_dir <- state$dbi_cache$result_cache_dir
  expect_true(length(list.files(cache_dir)) > 0L)
  expect_identical(page(a)$rows[["1"]], 1:2)
  sess:::handle_dataview_dispose(a)
  expect_false(dir.exists(cache_dir))
  expect_silent(count <- DBI::dbGetQuery(con, "SELECT COUNT(*) AS n FROM items"))
  expect_equal(count$n, nrow(fixture))
  expect_identical(page(b, 20000L)$rows[["1"]], 105010:105009)
  last <- page(b, 25000L, 25020L)
  expect_identical(last$rows[["1"]], 100010:100001)
  expect_equal(last$totalRows, 25010L)
  expect_true(DBI::dbIsValid(con))
  expect_equal(DBI::dbGetQuery(con, "SELECT COUNT(*) AS n FROM items")$n, 25010L)

  # Closing releases the reservation. Reopening that same viewer must close
  # its old cursor before the new metadata query, and remove its spilled cache.
  a <- sess:::dataview_register(ascending)
  views <- c(views, list(a))
  page(a, 20000L)
  state <- sess:::dataview_get_state(a$view_id)
  result <- state$dbi_cache$result
  cache_dir <- state$dbi_cache$result_cache_dir
  expect_true(DBI::dbIsValid(result))
  expect_true(length(list.files(cache_dir)) > 0L)
  expect_silent(replacement <- sess:::dataview_register(descending, view_id = a$view_id))
  views <- c(views, list(replacement))
  expect_false(DBI::dbIsValid(result))
  expect_false(dir.exists(cache_dir))
  expect_true(replacement$state_generation > a$state_generation)
  sess:::handle_dataview_dispose(a)
  expect_identical(page(replacement)$rows[["1"]], 25010:25009)

  # Reusing a dedicated connection outside the viewer must not silently
  # restart the query or append a new execution to previously cached rows.
  expect_warning(DBI::dbGetQuery(con, "SELECT 1"), "Closing open result set")
  cache <- sess:::dataview_get_state(replacement$view_id)$dbi_cache
  user_result <- DBI::dbSendQuery(con, "SELECT id FROM items ORDER BY id")
  expect_identical(DBI::dbFetch(user_result, n = 2L)$id, 1:2)
  for (attempt in 1:2) {
    expect_error(page(replacement, 6000L), "dedicated connection")
    expect_equal(cache$result_cache_rows, 5000L)
    expect_false(cache$result_complete)
    expect_identical(page(replacement)$rows[["1"]], 25010:25009)
  }
  expect_identical(page(b)$rows[["1"]], 125010:125009)
  expect_silent(sess:::handle_dataview_dispose(replacement))
  expect_true(DBI::dbIsValid(user_result))
  expect_identical(DBI::dbFetch(user_result, n = 2L)$id, 3:4)
  DBI::dbClearResult(user_result)
  expect_true(DBI::dbIsValid(con))
  expect_equal(DBI::dbGetQuery(con, "SELECT COUNT(*) AS n FROM items")$n, 25010L)
})

# Two dedicated connections to the SAME database must also remain independent.
if (requireNamespace("RSQLite", quietly = TRUE) &&
      requireNamespace("arrow", quietly = TRUE) &&
      requireNamespace("dbplyr", quietly = TRUE)) local({
  path <- tempfile(fileext = ".sqlite")
  con <- DBI::dbConnect(RSQLite::SQLite(), path)
  other <- DBI::dbConnect(RSQLite::SQLite(), path)
  views <- list()
  on.exit({
    for (view in views) sess:::handle_dataview_dispose(view)
    DBI::dbDisconnect(con)
    DBI::dbDisconnect(other)
    unlink(path)
  }, add = TRUE)
  DBI::dbWriteTable(con, "items", data.frame(id = 1:12000))
  tables <- list(dplyr::tbl(con, "items"), dplyr::tbl(other, "items"))
  for (table in tables) {
    views[[length(views) + 1L]] <- sess:::dataview_register(dplyr::arrange(table, id))
  }
  for (start in c(0L, 6000L, 0L, 11000L)) {
    for (view in views) {
      result <- sess:::handle_dataview_page(list(
        view_id = view$view_id, startRow = start, endRow = start + 2L
      ))
      expect_identical(result$rows[["1"]], seq.int(start + 1L, start + 2L))
    }
  }
})
