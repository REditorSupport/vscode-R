# A successful fetch advances the real cursor before its rows enter the cache.
if (requireNamespace("RSQLite", quietly = TRUE) &&
      requireNamespace("arrow", quietly = TRUE) &&
      requireNamespace("dbplyr", quietly = TRUE)) local({
  con <- DBI::dbConnect(RSQLite::SQLite(), ":memory:")
  on.exit(DBI::dbDisconnect(con), add = TRUE)
  fixture <- data.frame(id = seq_len(35010L))
  DBI::dbWriteTable(con, "items", fixture)
  query <- dplyr::arrange(dplyr::tbl(con, "items"), id)

  for (failure in c("error", "interrupt")) {
    for (stage in c("cache", "completion", "spill")) {
      for (prefill in if (stage == "spill") TRUE else c(FALSE, TRUE)) local({
        view <- sess:::dataview_register(query)
        on.exit(sess:::handle_dataview_dispose(view), add = TRUE)
        cache <- sess:::dataview_get_state(view$view_id)$dbi_cache
        page <- function(start = 0L, end = start + 2L) {
          sess:::handle_dataview_page(list(
            view_id = view$view_id, startRow = start, endRow = end
          ))
        }
        if (prefill) {
          page(30000L)
          expect_equal(cache$result_cache_rows, 35000L)
          expect_true(length(list.files(cache$result_cache_dir)) > 0L)
        }

        # Inject at cache entry, after the completion check, or after a spill
        # rename succeeds but before the cache records the finalized file.
        cursor <- NULL
        disk_files <- character()
        inject <- function() {
          cursor <<- cache$result
          disk_files <<- list.files(cache$result_cache_dir, full.names = TRUE)
          stop(structure(
            list(message = "injected after fetch", call = NULL),
            class = c(failure, "condition")
          ))
        }
        injection <- substitute(fail(), list(fail = inject))
        name <- switch(stage,
          cache = "dataview_dbi_result_cache_add",
          completion = "dbHasCompleted",
          spill = "file.rename"
        )
        where <- switch(stage,
          cache = asNamespace("sess"),
          completion = asNamespace("DBI"),
          spill = baseenv()
        )
        if (stage == "cache") {
          suppressMessages(trace(name, where = where, tracer = injection, print = FALSE))
        } else {
          suppressMessages(trace(name, where = where, exit = injection, print = FALSE))
        }
        traced <- TRUE
        on.exit({
          if (traced) suppressMessages(untrace(name, where = where))
        }, add = TRUE)
        caught <- tryCatch(
          page(if (prefill) 35000L else 0L),
          error = identity, interrupt = identity
        )
        suppressMessages(untrace(name, where = where))
        traced <- FALSE

        expect_true(inherits(caught, failure), info = stage)
        expect_identical(conditionMessage(caught), "injected after fetch")
        expect_false(DBI::dbIsValid(cursor))
        expect_null(cache$result)
        expect_equal(cache$result_cache_rows, 0L)
        expect_length(cache$result_cache_blocks, 0L)
        expect_false(cache$result_complete)
        expect_length(list.files(cache$result_cache_dir), 0L)
        if (stage == "spill") {
          # A newly finalized file exists before its path is published.
          expect_true(length(disk_files) >= 2L)
          expect_false(any(file.exists(disk_files)))
        }

        # Retrying must start at row one and reproduce every row exactly once,
        # including the spilled prefix and the final partial batch.
        first <- page()
        expect_identical(first$rows[["0"]], 1:2)
        expect_identical(first$rows[["1"]], 1:2)
        expect_equal(first$fetchedRows, 5000L)
        expect_equal(first$lastRow, -1L)
        all <- page(0L, nrow(fixture) + 2L)
        expect_identical(all$rows[["0"]], fixture$id)
        expect_identical(all$rows[["1"]], fixture$id)
        expect_equal(all$totalRows, nrow(fixture))
        expect_equal(all$lastRow, nrow(fixture))
        expect_true(cache$result_complete)
        expect_null(cache$result)
        expect_true(DBI::dbIsValid(con))
      })
    }
  }
})
