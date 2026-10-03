# Struct children must be bound by row, recursively, across reader/cache pages.
local({
  make_page <- function(id) {
    page <- data.frame(id = id)
    page$struct <- data.frame(flag = id %% 2L == 0L)
    page$struct$child <- data.frame(date = as.Date("2020-01-01") + id)
    page$struct$child$items <- lapply(id, function(i) c(i, -i))
    page
  }
  expect_equal(
    sess:::dataview_arrow_bind_pages(list(make_page(1:2), make_page(3:5))),
    make_page(1:5)
  )
})

if (requireNamespace("arrow", quietly = TRUE)) local({
  root <- tempfile("dataview-projection-")
  dir.create(root)
  view_ids <- character()
  on.exit({
    for (id in view_ids) sess:::handle_dataview_dispose(list(view_id = id))
    unlink(root, recursive = TRUE)
  }, add = TRUE)
  for (year in 2024:2025) {
    path <- file.path(root, paste0("year=", year))
    dir.create(path)
    ids <- (year - 2024L) * 6010L + seq_len(6010L)
    df <- data.frame(
      id = ids, score = -ids, flag = ids %% 2L == 0L,
      date = as.Date("2020-01-01") + ids,
      time = as.POSIXct("2020-01-01", tz = "Australia/Sydney") + ids
    )
    df$struct <- data.frame(value = ids, flag = df$flag)
    if (requireNamespace("bit64", quietly = TRUE)) {
      df$big <- bit64::as.integer64("9007199254740993") + bit64::as.integer64(ids)
    }
    arrow::write_parquet(df, file.path(path, "part.parquet"), chunk_size = 997L)
  }
  data <- arrow::open_dataset(root)
  expected <- sess:::dataview_arrow_data_frame(data)
  id <- sess:::dataview_register(data)$view_id
  expected_id <- sess:::dataview_register(expected)$view_id
  view_ids <- c(id, expected_id)
  field <- function(name) as.character(match(name, names(data)))
  model <- list(
    sortModel = list(list(colId = field("score"), sort = "asc")),
    filterModel = setNames(list(list(type = "true")), field("flag"))
  )
  expect_true(sess:::handle_dataview_init(list(view_id = id))$columnProjection)
  expect_false(sess:::handle_dataview_init(list(view_id = expected_id))$columnProjection)

  fragment_index <- NULL
  # Begin with a narrow projection: the fragment index must still retain the
  # full source schema so revealing more columns later can reuse that index.
  projections <- list(
    c("0", field("year"), field("id")),
    c("0", field("date"), field("time")),
    "0", character(),
    c("0", field("struct")),
    c("0", field("id"), field("big")),
    NULL
  )
  for (fields in projections) {
    for (start in c(0L, 4990L, 0L, 12020L)) {
      params <- c(list(startRow = start, endRow = start + 30L), model)
      reference <- sess:::handle_dataview_page(c(list(view_id = expected_id), params))
      actual <- sess:::handle_dataview_page(c(list(view_id = id, fields = fields), params))
      selected <- if (is.null(fields)) {
        names(reference$rows)
      } else {
        names(reference$rows)[names(reference$rows) %in% c("0", fields)]
      }
      reference$rows <- reference$rows[, selected, drop = FALSE]
      expect_equal(actual, reference)
      reader <- sess:::dataview_get_state(id)$arrow_reader
      expect_equal(reader$projection, which(as.character(seq_along(expected)) %in% selected))
      if (is.null(fragment_index)) fragment_index <- reader$fragment_index
      expect_identical(reader$fragment_index, fragment_index)
      for (block in reader$query_cache) {
        expect_equal(names(block$data), names(data)[reader$projection])
      }
    }
  }
  state <- sess:::dataview_get_state(id)
  expect_identical(state$data, data)
  expect_null(state$query_columns)

  # The same key used by a filter and a sort is collected once, and another
  # key joins the same projected scan; their original row ordering is retained.
  columns <- sess:::dataview_arrow_query_columns(
    state, list(list(colId = field("score"), sort = "asc")),
    setNames(list(list(type = "lessThan", filter = -10L), list(type = "true")),
             c(field("score"), field("flag")))
  )
  expect_equal(names(columns), as.character(match(c("score", "flag"), names(data)) + 1L))
  expect_equal(columns[[1L]], expected$score)
  expect_equal(columns[[2L]], expected$flag)
})

if (requireNamespace("arrow", quietly = TRUE)) local({
  root <- tempfile("dataview-fragments-")
  dir.create(root)
  view_ids <- character()
  on.exit({
    for (id in view_ids) sess:::handle_dataview_dispose(list(view_id = id))
    unlink(root, recursive = TRUE)
  }, add = TRUE)

  # Unequal files/row groups, an empty file, nulls, schema evolution, and
  # partition values which are not present in the physical Parquet columns.
  counts <- c(0L, 7001L, 3999L, 11000L, 8000L, 15000L, 15000L)
  ends <- cumsum(counts)
  starts <- c(1L, head(ends, -1L) + 1L)
  for (layout in c("hive", "directory")) {
    path <- file.path(root, layout)
    dir.create(path)
    for (i in seq_along(counts)) {
      partition <- if (layout == "hive") paste0("year=", 2020L + i) else as.character(2020L + i)
      if (layout == "hive" && i == 7L) partition <- "year=__HIVE_DEFAULT_PARTITION__"
      directory <- file.path(path, partition)
      dir.create(directory)
      ids <- if (counts[[i]]) seq.int(starts[[i]], ends[[i]]) else integer()
      df <- data.frame(
        id = ids,
        flag = c(TRUE, FALSE, NA, TRUE)[ids %% 4L + 1L],
        score = (ids * 7919L) %% 60000L
      )
      if (i %% 2L == 0L) df$extra <- ids
      arrow::write_parquet(df, file.path(directory, "data.parquet"), chunk_size = 997L)
    }
    data <- if (layout == "hive") {
      arrow::open_dataset(path, unify_schemas = TRUE)
    } else {
      arrow::open_dataset(path, partitioning = "year", unify_schemas = TRUE)
    }
    expected <- sess:::dataview_arrow_data_frame(data)
    id <- sess:::dataview_register(data)$view_id
    expected_id <- sess:::dataview_register(expected)$view_id
    view_ids <- c(view_ids, id, expected_id)
    field <- function(name) as.character(match(name, names(expected)))
    sort <- list(sortModel = list(list(colId = field("score"), sort = "desc")))
    true <- list(filterModel = setNames(list(list(type = "true")), field("flag")))
    false <- list(filterModel = setNames(list(list(type = "false")), field("flag")))
    year <- list(filterModel = setNames(
      list(list(type = "equals", filter = 2024L)), field("year")
    ))
    for (model in list(true, c(true, sort), false, c(false, sort), year, sort, list())) {
      # Cross cache blocks, evict earlier sorted blocks, and revisit old pages.
      for (start in c(0L, 4990L, 10000L, 15000L, 20000L, 25000L, 0L, 59990L)) {
        params <- c(list(startRow = start, endRow = start + 30L), model)
        actual <- sess:::handle_dataview_page(c(list(view_id = id), params))
        reference <- sess:::handle_dataview_page(c(list(view_id = expected_id), params))
        expect_equal(actual, reference, info = paste(layout, start))
        reader <- sess:::dataview_get_state(id)$arrow_reader
        expect_true(sum(vapply(reader$query_cache, function(x) nrow(x$data), integer(1))) <= 20000L)
      }
    }

    state <- sess:::dataview_get_state(id)
    index <- sess:::dataview_arrow_fragment_index(state)
    expect_equal(index$ends, ends[-1L])
    expect_equal(nrow(index$partition_values), 6L)
    # Duplicates and interleaved fragments must retain the requested order.
    rows <- c(60000L, 1L, 7001L, 7002L, 1L, 45001L, 11001L)
    page <- as.data.frame(sess:::dataview_arrow_fragment_slice(state, rows))
    rownames(page) <- NULL
    reference <- as.data.frame(expected[rows, , drop = FALSE])
    rownames(reference) <- NULL
    expect_equal(page, reference)

    # Large jumps and backward misses use fragments without moving the
    # sequential reader, which must remain usable for subsequent nearby pages.
    state <- sess:::dataview_to_state(data)
    sess:::dataview_arrow_slice(state, 1:30)
    reader <- state$arrow_reader$reader
    next_row <- state$arrow_reader$next_row
    for (rows in list(59001:59030, 45001:45030)) {
      expect_equal(sess:::dataview_arrow_slice(state, rows)$id, expected$id[rows])
      expect_identical(state$arrow_reader$reader, reader)
      expect_equal(state$arrow_reader$next_row, next_row)
    }
    expect_equal(sess:::dataview_arrow_slice(state, 1001:1030)$id, expected$id[1001:1030])
    expect_identical(state$arrow_reader$reader, reader)
    expect_equal(state$arrow_reader$next_row, next_row + 1000L)
    sess:::dataview_arrow_reader_reset(state)
  }

  # A single Parquet file uses row groups for distant/backward random access.
  path <- file.path(root, "single.parquet")
  ids <- seq_len(12020L)
  df <- data.frame(
    id = ids,
    score = (ids * 7919L) %% 12020L,
    flag = ids %% 2L == 0L
  )
  arrow::write_parquet(df, path, chunk_size = 997L)
  data <- arrow::open_dataset(path)
  expected <- sess:::dataview_arrow_data_frame(data)
  state <- sess:::dataview_to_state(data)
  sess:::dataview_arrow_slice(state, 1:30)
  reader <- state$arrow_reader$reader
  next_row <- state$arrow_reader$next_row
  for (rows in list(11001:11030, 7001:7030)) {
    expect_equal(sess:::dataview_arrow_slice(state, rows)$id, expected$id[rows])
    expect_identical(state$arrow_reader$reader, reader)
    expect_equal(state$arrow_reader$next_row, next_row)
  }
  index <- state$arrow_reader$row_group_index
  expect_equal(index$ends, c(seq(997, 11964, by = 997), 12020))
  expect_equal(sess:::dataview_arrow_slice(state, 1001:1030)$id, expected$id[1001:1030])
  expect_identical(state$arrow_reader$reader, reader)
  expect_equal(state$arrow_reader$next_row, next_row + 1000L)
  sess:::dataview_arrow_reader_reset(state)

  id <- sess:::dataview_register(data)$view_id
  expected_id <- sess:::dataview_register(df)$view_id
  view_ids <- c(view_ids, id, expected_id)
  filter <- list(filterModel = list("3" = list(type = "true")))
  sort <- list(sortModel = list(list(colId = "2", sort = "desc")))
  for (model in list(sort, filter, c(filter, sort))) {
    for (start in c(0L, 4990L, 9000L, 0L)) {
      params <- c(list(startRow = start, endRow = start + 30L), model)
      expect_equal(
        sess:::handle_dataview_page(c(list(view_id = id), params)),
        sess:::handle_dataview_page(c(list(view_id = expected_id), params))
      )
    }
  }

  # Multi-file structs also cross reader batches and query-cache boundaries.
  path <- file.path(root, "struct")
  dir.create(path)
  for (i in 1:3) {
    ids <- seq.int((i - 1L) * 2100L + 1L, i * 2100L)
    struct <- data.frame(flag = ids %% 2L == 0L, date = as.Date("2020-01-01") + ids)
    struct$child <- data.frame(value = ids)
    tab <- arrow::Table$create(id = ids, struct = arrow::StructArray$create(struct))
    if (i == 2L) tab <- arrow::Table$create(id = ids)
    arrow::write_parquet(tab, file.path(path, paste0(i, ".parquet")), chunk_size = 997L)
  }
  # Explicit nonlexical file order must also match the column/index scans.
  data <- arrow::open_dataset(rev(list.files(path, full.names = TRUE)), unify_schemas = TRUE)
  expected <- sess:::dataview_arrow_data_frame(data)
  id <- sess:::dataview_register(data)$view_id
  expected_id <- sess:::dataview_register(expected)$view_id
  view_ids <- c(view_ids, id, expected_id)
  for (model in list(list(), list(sortModel = list(list(colId = "1", sort = "desc"))))) {
    for (start in c(990L, 2090L, 4990L, 0L)) {
      params <- c(list(startRow = start, endRow = start + 30L), model)
      expect_equal(
        sess:::handle_dataview_page(c(list(view_id = id), params)),
        sess:::handle_dataview_page(c(list(view_id = expected_id), params))
      )
    }
  }
})
