# Mixed R column types survive paged RPC, including empty pages and missing values.
local({
  .sess_env <- sess:::.sess_env
  orig_dataviews <- .sess_env$dataviews
  orig_con <- .sess_env$con
  pipe <- processx::conn_create_pipepair()
  on.exit({
    .sess_env$dataviews <- orig_dataviews
    .sess_env$con <- orig_con
    lapply(pipe, close)
  }, add = TRUE)
  .sess_env$con <- pipe[[2L]]

  request <- function(method, params) {
    sess:::dispatch_message(as.character(jsonlite::toJSON(
      list(jsonrpc = "2.0", id = "types", method = method, params = params),
      auto_unbox = TRUE
    )))
    jsonlite::fromJSON(processx::conn_read_chars(pipe[[1L]]), simplifyVector = FALSE)
  }

  df <- data.frame(
    integer = c(42L, NA_integer_),
    double = c(1.54e-100, NA_real_),
    huge_double = c(1.23456789012345e14, NA_real_),
    logical = c(TRUE, NA),
    character = c('中文 😀 "quoted" <html>', NA_character_),
    factor = factor(c("apple", NA)),
    ordered = ordered(c("low", NA), levels = c("low", "high")),
    date = as.Date(c("2000-01-01", NA)),
    datetime = as.POSIXct(c("2020-01-01", NA), tz = "Australia/Sydney"),
    difftime = as.difftime(c(60, NA), units = "secs"),
    complex = c(1 + 2i, NA_complex_),
    raw = as.raw(c(0, 255)),
    check.names = FALSE
  )
  df[["column with spaces"]] <- c("001", "")
  df[["a.b$c@d"]] <- c(FALSE, TRUE)
  df$list <- list(list(number = 1L, value = 3 - 4i), NULL)
  df$complex_matrix <- I(matrix(c(1 + 2i, NA_complex_), ncol = 1))
  expected <- list(
    42L, 1.54e-100, 1.23456789012345e14, TRUE, '中文 😀 "quoted" <html>',
    "apple", "low", "2000-01-01", "2020-01-01T00:00:00", "60 secs",
    "1+2i", "0", "001", FALSE, list(number = 1L, value = "3-4i"), list("1+2i")
  )
  if (requireNamespace("bit64", quietly = TRUE)) {
    df$integer64 <- bit64::as.integer64(c("9007199254740993", NA))
    expected <- c(expected, list("9007199254740993"))
  }

  original <- serialize(df, NULL)
  registration <- sess:::dataview_register(df)
  view_id <- registration$view_id
  init <- request("dataview_init", list(view_id = view_id))
  expect_equal(init$result$totalRows, 2L)
  expect_length(init$result$columns, ncol(df) + 1L)
  for (name in c("complex", "raw", "list")) {
    column <- init$result$columns[[match(name, names(df)) + 1L]]
    expect_false(column$sortable, info = name)
    expect_false(column$filter, info = name)
  }

  page <- request("dataview_page", list(view_id = view_id, startRow = 0L, endRow = 1L))
  expect_null(page$error)
  expect_length(page$result$rows, 1L)
  actual <- unname(page$result$rows[[1L]][as.character(seq_along(expected))])
  expect_equal(actual, expected, tolerance = 1e-14)

  missing <- request("dataview_page", list(view_id = view_id, startRow = 1L, endRow = 2L))
  expect_null(missing$error)
  expect_length(missing$result$rows, 1L)
  for (name in c("integer", "double", "logical", "character", "factor", "ordered",
                 "date", "datetime", "difftime", "complex")) {
    expect_null(missing$result$rows[[1L]][[as.character(match(name, names(df)))]], info = name)
  }

  empty <- request("dataview_page", list(view_id = view_id, startRow = 2L, endRow = 3L))
  expect_null(empty$error)
  expect_length(empty$result$rows, 0L)
  expect_identical(serialize(df, NULL), original)

  for (values in list(c(1L, NA_integer_), c(1.54e-100, NA_real_), c(TRUE, NA),
                      c("中文", NA_character_), c(1 + 2i, NA_complex_), as.raw(c(0, 255)))) {
    matrix <- matrix(values, ncol = 1L)
    view_id <- sess:::dataview_register(matrix)$view_id
    page <- request("dataview_page", list(view_id = view_id, startRow = 0L, endRow = 2L))
    expect_null(page$error, info = typeof(values))
    expect_length(page$result$rows, 2L, info = typeof(values))
    if (is.complex(values)) {
      expect_equal(page$result$rows[[1L]][["1"]], "1+2i")
      expect_null(page$result$rows[[2L]][["1"]])
    }
  }

  df <- data.frame(id = 1:2)
  df$time <- as.POSIXlt(c("2020-01-01", NA), tz = "Australia/Sydney")
  view_id <- sess:::dataview_register(df)$view_id
  page <- request("dataview_page", list(view_id = view_id))
  expect_equal(page$result$rows[[1L]][["2"]], "2020-01-01T00:00:00")
  expect_null(page$result$rows[[2L]][["2"]])

  df <- data.frame(value = c(-Inf, Inf, NaN, NA_real_, 0, 1),
                   all_na_numeric = NA_real_, all_na_character = NA_character_)
  view_id <- sess:::dataview_register(df)$view_id
  page <- request("dataview_page", list(view_id = view_id))
  expect_null(page$error)
  expect_length(page$result$rows, 6L)
  expect_equal(page$result$rows[[5L]][["1"]], 0)
  expect_equal(page$result$rows[[6L]][["1"]], 1)
  for (row in page$result$rows) {
    expect_null(row[["2"]])
    expect_null(row[["3"]])
  }

  nested <- list(date = as.Date("2000-01-01"),
                 table = data.frame(value = 1:2), value = list(1 + 2i))
  formatted <- sess:::dataview_format_column(list(nested))[[1L]]
  expect_identical(formatted$date, nested$date)
  expect_equal(formatted$table, list(list(value = 1L), list(value = 2L)))
  expect_equal(formatted$value, list("1+2i"))
})

# Small numbers survive the actual JSON response and remain distinct in cached filters.
local({
  .sess_env <- sess:::.sess_env
  orig_dataviews <- .sess_env$dataviews
  orig_con <- .sess_env$con
  pipe <- processx::conn_create_pipepair()
  on.exit({
    .sess_env$dataviews <- orig_dataviews
    .sess_env$con <- orig_con
    lapply(pipe, close)
  }, add = TRUE)
  .sess_env$con <- pipe[[2L]]

  values <- c(1.54e-05, 3.54e-05, -6.65e-13, 1.54e-100, 0, 1.23456789)
  registration <- sess:::dataview_register(data.frame(value = values))
  page <- sess:::handle_dataview_page(list(view_id = registration$view_id))
  sess:::rpc_reply("page", page)
  response <- jsonlite::fromJSON(processx::conn_read_chars(pipe[[1L]]))
  actual <- response$result$rows[["1"]]
  expect_length(actual, length(values))
  expect_true(all(abs(actual - values) <= abs(values) * 1e-14))

  for (value in values[1:2]) {
    filtered <- sess:::handle_dataview_page(list(
      view_id = registration$view_id,
      filterModel = list("1" = list(type = "equals", filter = value))
    ))
    expect_equal(filtered$rows[["1"]], value, tolerance = 1e-14)
  }
})

# S3 and S4 numeric subclasses supply their own display and text-filter values.
local({
  registerS3method("[", "dataview_test", function(x, ...) {
    structure(NextMethod(), class = class(x))
  })
  class_env <- environment()
  methods::setClass("dataview_s4_test", contains = "numeric", where = class_env)
  on.exit({
    methods::removeMethod("[", "dataview_s4_test", where = class_env)
    methods::removeClass("dataview_s4_test", where = class_env)
    rm(
      list = c("[.dataview_test", "format.dataview_test", "format.dataview_s4_test"),
      envir = get(".__S3MethodsTable__.", envir = asNamespace("base"))
    )
  }, add = TRUE)
  methods::setMethod("[", "dataview_s4_test", function(x, i, j, ..., drop = TRUE) {
    methods::new("dataview_s4_test", as.numeric(x)[i])
  }, where = class_env)
  for (class_name in c("dataview_test", "dataview_s4_test")) {
    registerS3method("format", class_name, function(x, ...) {
      paste0("value:", as.numeric(x))
    })
  }

  values <- c(20, 2, 10, NA_real_)
  cases <- list(
    S3 = structure(values, class = "dataview_test"),
    S4 = methods::new("dataview_s4_test", values)
  )
  for (case_name in names(cases)) {
    df <- data.frame(id = 1:4)
    df$value <- cases[[case_name]]
    expect_equal(isS4(df$value), case_name == "S4", info = case_name)
    expect_true(is.numeric(df$value), info = case_name)
    expect_true(is.object(df$value), info = case_name)

    state <- sess:::dataview_to_state(df)
    expect_equal(as.character(state$columns[[3L]]$type), "textColumn", info = case_name)
    expect_equal(
      as.character(state$columns[[3L]]$filter), "agTextColumnFilter", info = case_name
    )
    expect_equal(
      sess:::dataview_rows(state, 1:4)[["2"]],
      c("value:20", "value:2", "value:10", NA_character_), info = case_name
    )
    expect_equal(sess:::dataview_query_indices(
      state, NULL, list("2" = list(type = "equals", filter = "value:2"))
    ), 2L, info = case_name)
  }
})


# A Dataset stand-in verifies row-fetch counts without scanning real files.
if (requireNamespace("arrow", quietly = TRUE)) local({
  row_takes <- 0L
  subset_arrow_lazy <- function(x, i, j, ..., drop = FALSE) {
    if (!missing(i) && length(i)) {
      row_takes <<- row_takes + 1L
    }
    class_name <- class(x)[[1L]]
    data <- structure(x, class = "data.frame")
    if (missing(i)) {
      return(structure(data[, j, drop = drop], class = c(class_name, "data.frame")))
    }
    page <- if (missing(j)) data[i, , drop = FALSE] else data[i, j, drop = drop]
    page
  }
  registerS3method("[", "dataview_dataset_test", subset_arrow_lazy)
  registerS3method("dim", "dataview_dataset_test", function(x) {
    dim(structure(x, class = "data.frame"))
  })
  registerS3method("names", "dataview_dataset_test", function(x) {
    names(structure(x, class = "data.frame"))
  })
  on.exit({
    rm(
      list = c(
        "[.dataview_dataset_test", "dim.dataview_dataset_test", "names.dataview_dataset_test"
      ),
      envir = get(".__S3MethodsTable__.", envir = asNamespace("base"))
    )
  }, add = TRUE)

  for (class_name in "dataview_dataset_test") {
    data <- structure(
      data.frame(
        id = 1:5,
        value = c("a", "b", "c", "d", "e"),
        score = c(5, 4, 3, 2, 1)
      ),
      class = c(class_name, "Dataset", "data.frame")
    )

    expect_true(sess:::dataview_is_table(data), info = class_name)
    state <- sess:::dataview_to_state(data)
    expect_equal(state$total_rows, 5L, info = class_name)
    expect_equal(
      vapply(state$columns[-1L], function(x) as.character(x$headerName), ""),
      names(data),
      info = class_name
    )

    page <- sess:::dataview_rows(state, 2:3)
    expect_equal(page[["1"]], 2:3, info = class_name)
    expect_equal(page[["2"]], c("b", "c"), info = class_name)
    expect_equal(page[["3"]], c(4, 3), info = class_name)

    filtered <- sess:::dataview_query_indices(
      state, NULL, list("2" = list(type = "equals", filter = "c"))
    )
    expect_equal(filtered, 3L, info = class_name)

    sorted <- sess:::dataview_query_indices(
      state, list(list(colId = "3", sort = "asc")), NULL
    )
    expect_equal(sorted, 5:1, info = class_name)
  }

  data <- structure(
    data.frame(id = 1:6000, score = 6000:1),
    class = c("dataview_dataset_test", "Dataset", "data.frame")
  )
  state <- sess:::dataview_to_state(data)
  # This data-frame stand-in has R row names; real Dataset objects do not.
  state$row_index <- NULL
  sort_model <- list(list(colId = "2", sort = "asc"))
  state$query_key <- sess:::dataview_query_key(sort_model, NULL)
  state$query_indices <- sess:::dataview_query_indices(state, sort_model, NULL)
  state$query_has_sort <- TRUE
  row_takes <- 0L

  page1 <- sess:::dataview_rows(
    state,
    state$query_indices[1:500],
    use_arrow_query_cache = TRUE,
    display_idx = 1:500
  )
  page2 <- sess:::dataview_rows(
    state,
    state$query_indices[501:1000],
    use_arrow_query_cache = TRUE,
    display_idx = 501:1000
  )

  expect_equal(row_takes, 1L)
  expect_equal(page1[["0"]], 6000:5501)
  expect_equal(page1[["2"]], 1:500)
  expect_equal(page2[["0"]], 5500:5001)
  expect_equal(page2[["2"]], 501:1000)

  page11 <- sess:::dataview_rows(
    state,
    state$query_indices[5001:5500],
    use_arrow_query_cache = TRUE,
    display_idx = 5001:5500
  )
  expect_equal(row_takes, 2L)
  expect_equal(page11[["0"]], 1000:501)
  expect_equal(page11[["2"]], 5001:5500)

  # Returning to an earlier sorted block does not rescan the source.
  again <- sess:::dataview_rows(
    state, state$query_indices[1:500], use_arrow_query_cache = TRUE, display_idx = 1:500
  )
  expect_equal(again, page1)
  expect_equal(row_takes, 2L)

  # The first 5,000 display rows were prefetched by the first query-cache miss.
  for (start in c(1001L, 2001L, 3001L, 4001L)) {
    sess:::dataview_rows(
      state,
      state$query_indices[start:(start + 999L)],
      use_arrow_query_cache = TRUE,
      display_idx = start:(start + 999L)
    )
  }
  expect_equal(row_takes, 2L)
  expect_length(state$arrow_reader$row_cache, 0L)
  expect_equal(
    sum(vapply(state$arrow_reader$query_cache, function(x) nrow(x$data), integer(1))),
    6000L
  )
  again11 <- sess:::dataview_rows(
    state,
    state$query_indices[5001:5500],
    use_arrow_query_cache = TRUE,
    display_idx = 5001:5500
  )
  expect_equal(again11, page11)
  expect_equal(row_takes, 2L)
})


# Real Arrow Dataset pages reuse one forward-only reader when Arrow is available.
if (requireNamespace("arrow", quietly = TRUE)) {
  local({
    Array <- getExportedValue("arrow", "Array")
    Table <- getExportedValue("arrow", "Table")
    int32 <- getExportedValue("arrow", "int32")
    list_of <- getExportedValue("arrow", "list_of")

    data <- Table$create(
      list_col = Array$create(
        list(c(1L, 2L), c(3L, 4L, 5L), integer()),
        type = list_of(int32())
      )
    )
    state <- sess:::dataview_to_state(data)
    page <- sess:::dataview_rows(state, 1:3)

    expect_true(is.list(page[["1"]]))
    expect_false(inherits(page[["1"]], "vctrs_list_of"))
    expect_equal(page[["1"]][[1L]], c(1L, 2L))
    expect_silent(jsonlite::toJSON(
      page, auto_unbox = TRUE, null = "null", force = TRUE, digits = NA
    ))
  })

  local({
    schema <- getExportedValue("arrow", "schema")
    Table <- getExportedValue("arrow", "Table")
    InMemoryDataset <- getExportedValue("arrow", "InMemoryDataset")
    int32 <- getExportedValue("arrow", "int32")
    utf8 <- getExportedValue("arrow", "utf8")
    list_of <- getExportedValue("arrow", "list_of")
    fixed_size_list_of <- getExportedValue("arrow", "fixed_size_list_of")
    map_of <- getExportedValue("arrow", "map_of")
    struct <- getExportedValue("arrow", "struct")

    data <- InMemoryDataset$create(Table$create(schema = schema(
      list_col = list_of(int32()),
      struct_col = struct(value = int32()),
      map_col = map_of(utf8(), int32()),
      fixed_list_col = fixed_size_list_of(int32(), 2L),
      int_col = int32()
    )))
    state <- sess:::dataview_to_state(data)

    for (position in 2:5) {
      expect_false(state$columns[[position]]$filter)
      expect_false(state$columns[[position]]$sortable)
    }
    expect_true(state$columns[[6L]]$sortable)
  })

  local({
    Table <- getExportedValue("arrow", "Table")
    StructArray <- getExportedValue("arrow", "StructArray")
    InMemoryDataset <- getExportedValue("arrow", "InMemoryDataset")

    data <- InMemoryDataset$create(Table$create(
      id = 1:4,
      struct_col = StructArray$create(data.frame(
        value = 11:14,
        label = c("a", "b", "c", "d")
      ))
    ))
    state <- sess:::dataview_to_state(data)
    page <- sess:::dataview_rows(state, 1:4, use_arrow_reader = TRUE)

    expect_true(is.list(page[["2"]]))
    expect_false(is.data.frame(page[["2"]]))
    expect_equal(page[["2"]][[1L]], list(value = 11L, label = "a"))
    expect_silent(jsonlite::toJSON(
      page, auto_unbox = TRUE, null = "null", force = TRUE, digits = NA
    ))
  })

  local({
    Array <- getExportedValue("arrow", "Array")
    Table <- getExportedValue("arrow", "Table")
    InMemoryDataset <- getExportedValue("arrow", "InMemoryDataset")
    int32 <- getExportedValue("arrow", "int32")
    list_of <- getExportedValue("arrow", "list_of")

    data <- InMemoryDataset$create(Table$create(
      id = 1:1200,
      list_col = Array$create(
        rep(list(c(1L, 2L), c(3L, 4L)), 600L),
        type = list_of(int32())
      )
    ))
    state <- sess:::dataview_to_state(data)
    sess:::dataview_rows(state, 501:1000, use_arrow_reader = TRUE)

    state$query_indices <- 1:100
    page <- sess:::dataview_arrow_query_slice(state, 1:100)

    expect_true(is.list(page[["list_col"]]))
    expect_false(inherits(page[["list_col"]], "vctrs_list_of"))
    expect_silent(jsonlite::toJSON(
      page, auto_unbox = TRUE, null = "null", force = TRUE, digits = NA
    ))
    state$arrow_reader$reader$Close()
  })

  local({
    sess_env <- sess:::.sess_env
    original_views <- sess_env$dataviews
    on.exit(sess_env$dataviews <- original_views, add = TRUE)

    InMemoryDataset <- getExportedValue("arrow", "InMemoryDataset")
    data <- InMemoryDataset$create(data.frame(
      id = 1:12,
      logical = rep(c(TRUE, FALSE, NA), 4L)
    ))
    view_id <- sess:::dataview_register(data)$view_id

    true_page <- sess:::handle_dataview_page(list(
      view_id = view_id, startRow = 0L, endRow = 20L,
      filterModel = list("2" = list(type = "true"))
    ))
    expect_true(all(true_page$rows[["2"]] %in% TRUE))

    false_page <- sess:::handle_dataview_page(list(
      view_id = view_id, startRow = 0L, endRow = 20L,
      filterModel = list("2" = list(type = "false"))
    ))
    expect_true(all(false_page$rows[["2"]] %in% FALSE))

    true_again <- sess:::handle_dataview_page(list(
      view_id = view_id, startRow = 0L, endRow = 20L,
      filterModel = list("2" = list(type = "true"))
    ))
    expect_true(all(true_again$rows[["2"]] %in% TRUE))
  })

  local({
    sess_env <- sess:::.sess_env
    original_views <- sess_env$dataviews
    path <- tempfile("dataview-arrow-")
    dir.create(path)
    view_ids <- character()
    on.exit({
      unlink(path, recursive = TRUE)
      for (view_id in view_ids) {
        sess:::handle_dataview_dispose(list(view_id = view_id))
      }
      sess_env$dataviews <- original_views
    }, add = TRUE)

    n <- 300L
    df <- data.frame(
      id = seq_len(n),
      logical_col = rep(c(TRUE, FALSE, NA), length.out = n),
      date_col = as.Date("2015-01-01") + rep(0:4, length.out = n),
      datetime_col = as.POSIXct("2015-01-01", tz = "Australia/Sydney") +
        rep(0:4, length.out = n),
      difftime_col = as.difftime(rep(0:4, length.out = n), units = "secs")
    )
    if (requireNamespace("bit64", quietly = TRUE)) {
      df$int64_col <- bit64::as.integer64("9007199254740993") +
        bit64::as.integer64(seq_len(n))
    }
    for (i in seq_len(10L)) {
      rows <- seq.int((i - 1L) * 30L + 1L, i * 30L)
      arrow::write_parquet(
        df[rows, , drop = FALSE],
        file.path(path, sprintf("part-%02d.parquet", i))
      )
    }

    data <- arrow::open_dataset(path, format = "parquet")
    view_id <- sess:::dataview_register(data)$view_id
    expected_id <- sess:::dataview_register(df)$view_id
    view_ids <- c(view_id, expected_id)

    state <- sess:::dataview_get_state(view_id)
    expect_equal(as.character(state$columns[[4L]]$type), "dateColumn")
    expect_equal(as.character(state$columns[[5L]]$type), "datetimeColumn")
    expect_equal(as.character(state$columns[[6L]]$type), "textColumn")
    if ("int64_col" %in% names(df)) {
      expect_equal(as.character(state$columns[[7L]]$type), "bigintColumn")
      expect_true(inherits(
        sess:::dataview_arrow_column(data, match("int64_col", names(data))),
        "integer64"
      ))
    }
    expect_true(inherits(
      sess:::dataview_arrow_column(data, match("date_col", names(data))),
      "Date"
    ))

    compare_page <- function(params) {
      actual <- sess:::handle_dataview_page(c(list(view_id = view_id), params))
      expected <- sess:::handle_dataview_page(c(list(view_id = expected_id), params))
      expect_equal(actual, expected)
      expect_silent(jsonlite::toJSON(
        actual, auto_unbox = TRUE, null = "null", force = TRUE, digits = NA
      ))
      actual
    }

    true_page <- compare_page(list(
      startRow = 0L, endRow = n,
      filterModel = list("2" = list(type = "true"))
    ))
    expect_true(all(true_page$rows[["2"]] %in% TRUE))

    target_date <- as.Date("2015-01-03")
    date_page <- compare_page(list(
      startRow = 0L, endRow = n,
      filterModel = list("3" = list(
        type = "equals", dateFrom = as.character(target_date)
      ))
    ))
    expect_equal(date_page$totalRows, sum(df$date_col == target_date))

    true_again <- compare_page(list(
      startRow = 0L, endRow = n,
      filterModel = list("2" = list(type = "true"))
    ))
    expect_true(all(true_again$rows[["2"]] %in% TRUE))

    sorted_page <- compare_page(list(
      startRow = 0L, endRow = n,
      sortModel = list(list(colId = "1", sort = "desc"))
    ))
    expect_equal(sorted_page$rows[["1"]], rev(df$id))

    reader_state <- sess:::dataview_get_state(view_id)$arrow_reader
    expect_null(reader_state$reader)
    expect_equal(length(reader_state$fragment_index$datasets), 10L)
    expect_equal(reader_state$fragment_index$ends, seq(30, n, by = 30))
  })

  local({
    InMemoryDataset <- getExportedValue("arrow", "InMemoryDataset")
    data <- InMemoryDataset$create(data.frame(id = 1:1200, value = sprintf("v%04d", 1:1200)))
    state <- sess:::dataview_to_state(data)

    page1 <- sess:::dataview_rows(state, 1:500, use_arrow_reader = TRUE)
    reader <- state$arrow_reader$reader
    page2 <- sess:::dataview_rows(state, 501:1000, use_arrow_reader = TRUE)

    expect_identical(state$arrow_reader$reader, reader)
    expect_equal(state$arrow_reader$next_row, 1001L)
    expect_equal(page1[["1"]], 1:500)
    expect_equal(page2[["1"]], 501:1000)

    cached <- sess:::dataview_rows(state, 101:200, use_arrow_reader = TRUE)
    expect_identical(state$arrow_reader$reader, reader)
    expect_equal(state$arrow_reader$next_row, 1001L)
    expect_equal(cached[["1"]], 101:200)

    sess:::dataview_arrow_reader_reset(state)
    expect_null(state$arrow_reader$reader)
    state$arrow_reader$row_cache <- list()
    filtered_idx <- seq.int(2L, 1000L, by = 2L)
    filtered <- sess:::dataview_rows(state, filtered_idx, use_arrow_reader = TRUE)
    expect_equal(state$arrow_reader$next_row, 1001L)
    expect_equal(filtered[["1"]], filtered_idx)

    filtered_reader <- state$arrow_reader$reader
    filtered_next <- sess:::dataview_rows(
      state, seq.int(1002L, 1200L, by = 2L), use_arrow_reader = TRUE
    )
    expect_identical(state$arrow_reader$reader, filtered_reader)
    expect_equal(state$arrow_reader$next_row, 1201L)
    expect_equal(filtered_next[["1"]], seq.int(1002L, 1200L, by = 2L))

    state$arrow_reader$reader$Close()
  })

  local({
    InMemoryDataset <- getExportedValue("arrow", "InMemoryDataset")
    data <- InMemoryDataset$create(data.frame(id = 1:25000))
    state <- sess:::dataview_to_state(data)

    sess:::dataview_rows(state, 1:500, use_arrow_reader = TRUE)
    sess:::dataview_rows(state, 5001:5500, use_arrow_reader = TRUE)
    sess:::dataview_rows(state, 10001:10500, use_arrow_reader = TRUE)
    sess:::dataview_rows(state, 15001:15500, use_arrow_reader = TRUE)

    expect_equal(
      vapply(state$arrow_reader$row_cache, function(x) x$first_row, integer(1)),
      c(1L, 5001L, 10001L, 15001L)
    )

    reader <- state$arrow_reader$reader
    next_row <- state$arrow_reader$next_row
    sess:::dataview_rows(state, 1:500, use_arrow_reader = TRUE)
    expect_identical(state$arrow_reader$reader, reader)
    expect_equal(state$arrow_reader$next_row, next_row)

    sess:::dataview_rows(state, 20001:20500, use_arrow_reader = TRUE)
    expect_equal(
      vapply(state$arrow_reader$row_cache, function(x) x$first_row, integer(1)),
      c(5001L, 10001L, 15001L, 1L, 20001L)
    )

    reader <- state$arrow_reader$reader
    next_row <- state$arrow_reader$next_row
    sess:::dataview_rows(state, 1:500, use_arrow_reader = TRUE)
    expect_identical(state$arrow_reader$reader, reader)
    expect_equal(state$arrow_reader$next_row, next_row)

    sess:::dataview_rows(state, 5001:5500, use_arrow_reader = TRUE)
    expect_identical(state$arrow_reader$reader, reader)
    expect_equal(state$arrow_reader$next_row, next_row)

    state$arrow_reader$reader$Close()
  })

  # Filtered and sorted display blocks use a query-local display cache and
  # preserve row order across page boundaries and model changes.
  local({
    sess_env <- sess:::.sess_env
    original_views <- sess_env$dataviews
    view_ids <- character()
    on.exit({
      for (view_id in view_ids) sess:::handle_dataview_dispose(list(view_id = view_id))
      sess_env$dataviews <- original_views
    }, add = TRUE)
    df <- data.frame(
      id = seq_len(50000L),
      score = (seq_len(50000L) * 7919L) %% 50000L,
      group = rep(c("a", "b"), 25000L),
      rank = ordered(rep(c("low", "high", NA, "low"), 12500L), levels = c("low", "high"))
    )
    data <- getExportedValue("arrow", "InMemoryDataset")$create(df)
    view_id <- sess:::dataview_register(data)$view_id
    expected_id <- sess:::dataview_register(df)$view_id
    view_ids <- c(view_id, expected_id)
    compare_page <- function(start, model = list(), size = 500L) {
      params <- c(list(startRow = start, endRow = start + size), model)
      actual <- sess:::handle_dataview_page(c(list(view_id = view_id), params))
      expected <- sess:::handle_dataview_page(c(list(view_id = expected_id), params))
      expect_equal(actual, expected)
      reader_state <- sess:::dataview_get_state(view_id)$arrow_reader
      expect_true(sum(vapply(
        reader_state$query_cache,
        function(x) nrow(x$data),
        integer(1)
      )) <= 20000L)
    }
    filter <- list(filterModel = list("3" = list(type = "equals", filter = "b")))
    sort <- list(sortModel = list(list(colId = "2", sort = "desc")))
    compare_page(0L, filter)
    reader_state <- sess:::dataview_get_state(view_id)$arrow_reader
    reader <- reader_state$reader
    expect_false(is.null(reader))
    expect_equal(reader_state$next_row, 2001L)
    expect_equal(length(reader_state$query_cache), 1L)
    compare_page(500L, filter)
    expect_identical(reader_state$reader, reader)
    expect_equal(reader_state$next_row, 2001L)
    expect_equal(length(reader_state$query_cache), 1L)
    compare_page(5000L, filter)
    expect_identical(reader_state$reader, reader)
    expect_equal(reader_state$next_row, 12001L)
    expect_equal(length(reader_state$query_cache), 2L)
    compare_page(0L, filter)
    expect_equal(reader_state$next_row, 12001L)
    expect_equal(length(reader_state$query_cache), 2L)

    for (model in list(sort, c(filter, sort), list(), filter,
                       list(sortModel = list(list(colId = "4", sort = "asc"))))) {
      for (start in c(0L, 4990L, 10000L, 20000L, 5000L, 0L)) {
        compare_page(start, model)
      }
    }
    compare_page(0L, sort, size = 21000L)
    compare_page(50000L)
    compare_page(0L, list(filterModel = list("1" = list(type = "lessThan", filter = 0L))))
  })

  if (requireNamespace("dplyr", quietly = TRUE)) {
    local({
      sess_env <- sess:::.sess_env
      original_views <- sess_env$dataviews
      view_ids <- character()
      on.exit({
        for (view_id in view_ids) sess:::handle_dataview_dispose(list(view_id = view_id))
        sess_env$dataviews <- original_views
      }, add = TRUE)
      data <- getExportedValue("arrow", "InMemoryDataset")$create(data.frame(
        id = seq_len(12020L), group = rep(c("a", "b"), 6010L)
      ))
      query <- dplyr::arrange(data, dplyr::desc(id))
      score_data <- getExportedValue("arrow", "InMemoryDataset")$create(data.frame(
        id = seq_len(12020L),
        score = (seq_len(12020L) * 7919L) %% 12020L
      ))
      score_query <- dplyr::arrange(score_data, dplyr::desc(score))
      score_view_id <- sess:::dataview_register(score_query)$view_id
      score_expected_id <- sess:::dataview_register(
        sess:::dataview_arrow_data_frame(score_query)
      )$view_id
      view_ids <- c(view_ids, score_view_id, score_expected_id)
      for (direction in c("asc", "desc")) {
        params <- list(
          startRow = 0L, endRow = 30L,
          sortModel = list(list(colId = "1", sort = direction))
        )
        actual <- sess:::handle_dataview_page(c(list(view_id = score_view_id), params))
        expected <- sess:::handle_dataview_page(c(list(view_id = score_expected_id), params))
        expect_equal(actual, expected)
      }
      grouped <- dplyr::group_by(query, group)
      aggregated <- dplyr::arrange(
        dplyr::summarise(dplyr::group_by(data, group), total = sum(id)), group
      )
      for (data in list(query, grouped, aggregated)) {
        view_id <- sess:::dataview_register(data)$view_id
        expected_df <- sess:::dataview_arrow_data_frame(data)
        expected_id <- sess:::dataview_register(expected_df)$view_id
        view_ids <- c(view_ids, view_id, expected_id)
        expect_true(sess:::handle_dataview_init(list(view_id = view_id))$columnProjection)
        for (model in list(
          list(),
          list(sortModel = list(list(colId = "1", sort = "asc"))),
          list(filterModel = list("1" = list(type = "equals", filter = expected_df[[1L]][1L]))),
          list(
            filterModel = list("2" = list(type = "equals", filter = expected_df[[2L]][1L])),
            sortModel = list(list(colId = "1", sort = "asc"))
          )
        )) {
          for (start in c(0L, 5000L, 4990L, 0L, 12020L)) {
            params <- c(list(startRow = start, endRow = start + 20L), model)
            actual <- sess:::handle_dataview_page(c(list(view_id = view_id), params))
            expected <- sess:::handle_dataview_page(c(list(view_id = expected_id), params))
            expect_equal(actual, expected)
          }
        }

        params <- list(startRow = 0L, endRow = 20L, fields = "2")
        actual <- sess:::handle_dataview_page(c(list(view_id = view_id), params))
        expected <- sess:::handle_dataview_page(c(list(view_id = expected_id), params))
        expected$rows <- expected$rows[, c("0", "2"), drop = FALSE]
        expect_equal(actual, expected)
        expect_equal(sess:::dataview_get_state(view_id)$arrow_reader$projection, 2L)
      }
    })
  }
}
