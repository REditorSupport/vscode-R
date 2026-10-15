# Viewer controls operate on the result of one execution, not on the source.
if (requireNamespace("arrow", quietly = TRUE)) local({
  path <- tempfile("dataview-lazy-query-", fileext = ".parquet")
  views <- list()
  on.exit({
    for (view in views) sess:::handle_dataview_dispose(list(
      view_id = view$view_id, state_generation = view$state_generation
    ))
    unlink(path)
  }, add = TRUE)
  register <- function(data) {
    view <- sess:::dataview_register(data)
    views[[length(views) + 1L]] <<- view
    view
  }
  ids <- seq_len(50010L)
  df <- data.frame(
    id = ids, score = ids %% 7L, flag = ids %% 2L == 0L,
    label = rep(c("Alpha", "beta", NA_character_), length.out = length(ids)),
    date = as.Date("2024-01-01") + ids %% 5L,
    time = as.POSIXct("2024-01-01", tz = "UTC") + ids
  )
  if (requireNamespace("bit64", quietly = TRUE)) {
    df$big <- bit64::as.integer64("9007199254740993") + bit64::as.integer64(ids)
  }
  arrow::write_parquet(df, path, chunk_size = 5000L)
  source <- arrow::open_dataset(path)
  query <- dplyr::filter(source, id > 10L)
  expected <- df[df$id > 10L, ]
  rownames(expected) <- NULL
  view <- register(query)
  stream_view_id <- view$view_id
  stream_reader <- sess:::dataview_arrow_reader_open(query)
  observed <- list()
  observed_rows <- 0L
  reference_rows <- -1L
  stream_cache <- sess:::dataview_get_state(view$view_id)$arrow_reader
  stream_cache$reader <- list(
    read_next_batch = function() {
      batch <- stream_reader$read_next_batch()
      if (!is.null(batch)) {
        observed[[length(observed) + 1L]] <<- sess:::dataview_arrow_data_frame(batch)
        observed_rows <<- observed_rows + nrow(batch)
      }
      batch
    },
    Close = stream_reader$Close
  )
  reference <- register(expected)
  columns <- sess:::handle_dataview_init(list(view_id = view$view_id))$columns
  expect_true(all(vapply(columns[-1L], function(column) {
    !isFALSE(column$filter) && !isFALSE(column$sortable)
  }, logical(1))))
  field <- function(name) as.character(match(name, names(df)))
  request <- function(model = list(), start = 0L, fields = NULL) {
    params <- c(list(startRow = start, endRow = start + 20L, fields = fields), model)
    actual <- sess:::handle_dataview_page(c(list(view_id = view$view_id), params))
    # Preserve the order of THIS execution, including stable sort ties and
    # row labels. A separate collect() may deliver batches in another order.
    if (identical(view$view_id, stream_view_id) && reference_rows != observed_rows) {
      expected <<- sess:::dataview_arrow_bind_pages(observed)
      reference <<- register(expected)
      reference_rows <<- observed_rows
    }
    expected_page <- sess:::handle_dataview_page(c(list(view_id = reference$view_id), params))
    if (!is.null(fields)) {
      selected <- names(expected_page$rows) %in% c("0", fields)
      expected_page$rows <- expected_page$rows[, selected, drop = FALSE]
    }
    expect_equal(actual$rows, expected_page$rows)
    if (actual$lastRow != -1L) {
      expect_equal(actual$totalRows, expected_page$totalRows)
      expect_equal(actual$totalUnfiltered, nrow(expected))
      expect_equal(actual$lastRow, expected_page$totalRows)
    }
    actual
  }
  expect_equal(request()$lastRow, -1L)
  cache <- sess:::dataview_get_state(view$view_id)$arrow_reader
  expect_false(cache$result_complete)
  reader <- cache$reader
  sort <- list(sortModel = list(
    list(colId = field("score"), sort = "desc"), list(colId = field("label"), sort = "asc")
  ))
  request(sort, fields = field("id"))
  expect_true(cache$result_complete)
  contents <- expected[order(expected$id), , drop = FALSE]
  rownames(contents) <- NULL
  source_contents <- df[df$id > 10L, ]
  rownames(source_contents) <- NULL
  expect_equal(contents, source_contents)
  expect_identical(cache$reader, reader)
  expect_true(any(vapply(cache$result_cache_batches, function(batch) {
    !is.null(batch$path) && file.exists(batch$path)
  }, logical(1))))
  expect_true(sum(vapply(cache$result_cache_batches, function(batch) {
    if (is.null(batch$data)) 0L else nrow(batch$data)
  }, integer(1))) <= sess:::dataview_arrow_cache_rows)
  indices <- cache$result_query_indices
  request(sort, 4990L, c(field("date"), field("time")))
  expect_identical(cache$result_query_indices, indices)

  # TOP N and aggregation remain inside the original query's result boundary.
  for (q in list(
    head(dplyr::arrange(query, dplyr::desc(id)), 100L),
    dplyr::arrange(dplyr::summarise(dplyr::group_by(query, flag), total = sum(id)), flag),
    dplyr::filter(query, id < 0L)
  )) {
    saved_view <- view
    saved_reference <- reference
    saved_expected <- expected
    expected <- as.data.frame(sess:::dataview_arrow_data_frame(q))
    rownames(expected) <- NULL
    view <- register(q)
    reference <- register(expected)
    request(list(sortModel = list(list(colId = "1", sort = "asc"))))
    request(list(filterModel = list("1" = list(type = "lessThan", filter = 0L))))
    request()
    view <- saved_view
    reference <- saved_reference
    expected <- saved_expected
  }

  # Forbid reopening the source after completion. This also works on Windows,
  # where the finished reader can retain a file handle until disposal.
  suppressMessages(trace(
    "dataview_arrow_reader_open", where = asNamespace("sess"),
    tracer = quote(stop("viewer controls must reuse the cached execution")), print = FALSE
  ))
  on.exit(suppressMessages(untrace(
    "dataview_arrow_reader_open", where = asNamespace("sess")
  )), add = TRUE)
  models <- list(
    c(list(filterModel = setNames(list(list(type = "true")), field("flag"))), sort),
    list(filterModel = setNames(list(list(type = "true")), field("flag"))),
    list(filterModel = setNames(list(list(type = "contains", filter = "ALP")), field("label"))),
    list(filterModel = setNames(list(list(type = "blank")), field("label"))),
    list(filterModel = setNames(
      list(list(type = "equals", dateFrom = "2024-01-03")), field("date")
    )),
    list(filterModel = list("1" = list(type = "lessThan", filter = 0L))),
    list(), sort
  )
  if ("big" %in% names(df)) models <- c(models, list(list(
    filterModel = setNames(
      list(list(type = "equals", filter = as.character(df$big[[21L]]))), field("big")
    ),
    sortModel = list(list(colId = field("big"), sort = "desc"))
  )))
  for (model in models) {
    for (start in c(0L, 4990L, 49990L, 0L)) request(model, start, field("id"))
    request(model, fields = character())
    expect_identical(cache$reader, reader)
  }
  request()
  expect_null(cache$result_query_indices)
})

# Exercise a non-file-order stream on every OS, independent of thread timing.
if (requireNamespace("arrow", quietly = TRUE)) local({
  df <- data.frame(id = 1:25000, key = rep(1:5, 5000), text = as.character(1:25000))
  blocks <- lapply(c(3L, 1L, 5L, 2L, 4L), function(i) {
    df[seq.int((i - 1L) * 5000L + 1L, i * 5000L), , drop = FALSE]
  })
  expected <- do.call(rbind, blocks)
  rownames(expected) <- NULL
  query <- dplyr::filter(arrow::Table$create(df), id > 0L)
  view <- sess:::dataview_register(query)
  reference <- sess:::dataview_register(expected)
  on.exit({
    sess:::handle_dataview_dispose(view)
    sess:::handle_dataview_dispose(reference)
  }, add = TRUE)
  cache <- sess:::dataview_get_state(view$view_id)$arrow_reader
  cache$reader <- arrow::RecordBatchReader$create(
    batches = lapply(blocks, arrow::as_record_batch)
  )
  request <- function(start, model = list(), fields = NULL) {
    params <- c(list(startRow = start, endRow = start + 20L, fields = fields), model)
    actual <- sess:::handle_dataview_page(c(list(view_id = view$view_id), params))
    wanted <- sess:::handle_dataview_page(c(list(view_id = reference$view_id), params))
    if (!is.null(fields)) wanted$rows <- wanted$rows[, c("0", fields), drop = FALSE]
    expect_equal(actual$rows, wanted$rows)
    if (actual$lastRow >= 0L) expect_equal(actual$totalRows, wanted$totalRows)
  }
  request(0L)
  expect_false(cache$result_complete)
  sort <- list(sortModel = list(list(colId = "2", sort = "asc")))
  filter <- list(filterModel = list("2" = list(type = "equals", filter = 3L)))
  for (model in list(sort, filter, c(filter, sort), list())) {
    for (start in c(0L, 4990L, 24980L, 0L)) request(start, model, c("1", "3"))
  }
  expect_true(cache$result_complete)
  expect_true(any(vapply(cache$result_cache_batches, function(batch) {
    !is.null(batch$path) && file.exists(batch$path)
  }, logical(1))))
  expect_null(cache$result_query_indices)
})
