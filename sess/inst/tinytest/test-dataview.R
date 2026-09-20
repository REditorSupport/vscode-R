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
  expect_identical(formatted$table, nested$table)
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

# Inline numeric labels honor R print options without changing the raw RPC values.
local({
  .sess_env <- sess:::.sess_env
  orig_dataviews <- .sess_env$dataviews
  orig_con <- .sess_env$con
  orig_options <- options(digits = 7, scipen = 0, OutDec = ".")
  pipe <- processx::conn_create_pipepair()
  on.exit({
    .sess_env$dataviews <- orig_dataviews
    .sess_env$con <- orig_con
    options(orig_options)
    lapply(pipe, close)
  }, add = TRUE)
  .sess_env$con <- pipe[[2L]]

  request <- function(view_id, ...) {
    sess:::dispatch_message(as.character(jsonlite::toJSON(
      list(jsonrpc = "2.0", id = "formatted", method = "dataview_page",
           params = c(list(view_id = view_id, formatNumbers = TRUE), list(...))),
      auto_unbox = TRUE, digits = NA
    )))
    response <- jsonlite::fromJSON(processx::conn_read_chars(pipe[[1L]]),
                                   simplifyVector = FALSE)
    expect_null(response$error)
    response$result
  }

  values <- c(326 / 0.23, 326 / 0.21, 1400)
  df <- data.frame(value = values, tiny = c(1.54e-100, 2.54e-100, 0),
                   text = c("001.234567890123", "<script>", "9007199254740993"))
  cases <- list(frame = df, matrix = as.matrix(df[1:2]))
  if (requireNamespace("data.table", quietly = TRUE)) {
    cases$table <- data.table::as.data.table(df)
  }
  for (case in cases) {
    original <- serialize(case, NULL)
    view_id <- sess:::dataview_register(case)$view_id
    page <- request(view_id)
    expect_equal(unlist(page$formattedColumns[["1"]]), c("1417.391", "1552.381", "1400.000"))
    expect_equal(unlist(page$formattedColumns[["2"]]), format(df$tiny, trim = TRUE))
    expect_equal(vapply(page$rows, `[[`, numeric(1), "1"), values, tolerance = 1e-14)
    expect_null(page$formattedColumns[["0"]])
    expect_null(page$formattedColumns[["3"]])

    single <- request(view_id, startRow = 1L, endRow = 2L)
    expect_equal(single$formattedColumns[["1"]], list("1552.381"))
    expect_length(request(view_id, startRow = 3L)$formattedColumns[["1"]], 0L)
    raw <- sess:::handle_dataview_page(list(view_id = view_id))
    expect_null(raw$formattedColumns)
    expect_identical(raw$rows[["1"]], values)

    sorted <- request(view_id, sortModel = list(list(colId = "1", sort = "asc")))
    expect_equal(unlist(sorted$formattedColumns[["1"]]), c("1400.000", "1417.391", "1552.381"))
    filtered <- request(view_id, filterModel = list("1" = list(type = "equals", filter = 1400)))
    expect_length(filtered$rows, 1L)
    expect_equal(filtered$formattedColumns[["1"]], list("1400"))
    expect_identical(serialize(case, NULL), original)
  }

  view_id <- sess:::dataview_register(df)$view_id
  for (settings in list(list(digits = 4), list(digits = 12),
                        list(scipen = 999), list(scipen = -9, OutDec = ","))) {
    options(settings)
    page <- request(view_id)
    expect_equal(unlist(page$formattedColumns[["1"]]), format(values, trim = TRUE))
    expect_equal(unlist(page$formattedColumns[["2"]]), format(df$tiny, trim = TRUE))
    expect_equal(vapply(page$rows, `[[`, numeric(1), "1"), values, tolerance = 1e-14)
    options(digits = 7, scipen = 0, OutDec = ".")
  }

  special <- data.frame(value = c(NA_real_, NaN, Inf, -Inf), integer = c(1L, NA, 2L, 3L))
  if (requireNamespace("bit64", quietly = TRUE)) {
    special$integer64 <- bit64::as.integer64(c("9007199254740993", NA, "1", "2"))
  }
  view_id <- sess:::dataview_register(special)$view_id
  page <- request(view_id)
  expect_equal(unlist(page$formattedColumns[["1"]]), c("NA", "NaN", "Inf", "-Inf"))
  expect_equal(unlist(page$formattedColumns[["2"]]), c("1", "NA", "2", "3"))
  expect_null(page$formattedColumns[["3"]])
  if ("integer64" %in% names(special)) {
    expect_equal(page$rows[[1L]][["3"]], "9007199254740993")
  }
  empty <- sess:::dataview_register(df[0, ])$view_id
  expect_length(request(empty)$formattedColumns[["1"]], 0L)
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

# aggregate() can return a matrix per column. Its cells are tuples, not scalars.
local({
  .sess_env <- sess:::.sess_env
  original_views <- .sess_env$dataviews
  on.exit({
    .sess_env$dataviews <- original_views
  })
  df <- aggregate(cbind(Ozone, Temp) ~ Month, airquality, quantile,
                  probs = c(.25, .5, .75))
  original <- serialize(df, NULL)
  view_id <- sess:::dataview_register(df)$view_id
  state <- sess:::dataview_get_state(view_id)
  for (position in 3:4) {
    expect_equal(as.character(state$columns[[position]]$type), "textColumn")
    expect_false(state$columns[[position]]$sortable)
    expect_false(state$columns[[position]]$filter)
  }
  # Ignore stale or externally supplied scalar queries on composite columns.
  page <- sess:::handle_dataview_page(list(
    view_id = view_id, formatNumbers = TRUE,
    sortModel = list(list(colId = "2", sort = "desc")),
    filterModel = list("3" = list(type = "greaterThan", filter = 70))
  ))
  expect_equal(page$totalRows, 5L)
  expect_identical(page$rows[["2"]], df$Ozone)
  expect_null(page$formattedColumns[["2"]])
  # Scalar columns still query and page the complete matrix rows together.
  page <- sess:::handle_dataview_page(list(
    view_id = view_id, startRow = 1L, endRow = 3L,
    sortModel = list(list(colId = "1", sort = "desc"))
  ))
  expect_identical(page$rows[["2"]], df$Ozone[c(4L, 3L), , drop = FALSE])
  expect_identical(serialize(df, NULL), original)
})

# Workspace children expose View for both structured and text-viewable objects.
local({
  selector <- list(kind = "index", value = 1L)
  expect_true(sess:::workspace_child_item(data.frame(x = 1), "df", selector)$viewable)
  expect_true(sess:::workspace_child_item(matrix(1:4, 2), "matrix", selector)$viewable)
  expect_true(sess:::workspace_child_item(list(x = 1), "list", selector)$viewable)
  expect_true(sess:::workspace_child_item(new.env(), "environment", selector)$viewable)
  expect_true(sess:::workspace_child_item(pairlist(x = 1), "pairlist", selector)$viewable)
  methods::setClass("list_viewer_test_slots", slots = c(child = "list"))
  on.exit(methods::removeClass("list_viewer_test_slots"), add = TRUE)
  object <- methods::new("list_viewer_test_slots", child = list(x = 1))
  expect_true(sess:::workspace_child_item(object, "S4", selector)$viewable)
  expect_true(sess:::workspace_child_item(1:3, "vector", selector)$viewable)
})
