# Exercise the DBI cursor contract without a database server or credentials.
if (requireNamespace("DBI", quietly = TRUE) &&
      requireNamespace("dbplyr", quietly = TRUE) &&
      requireNamespace("arrow", quietly = TRUE)) local({
  class_env <- environment()
  methods::setClass("dataview_dbi_test", contains = "DBIConnection", where = class_env)
  methods::setClass("dataview_dbi_test_result", contains = "DBIResult", where = class_env)
  registerS3method(
    "dbplyr_edition", "dataview_dbi_test", function(con) 2L, envir = asNamespace("dbplyr")
  )
  registered <- list()
  method <- function(name, signature, definition) {
    assign(name, getExportedValue("DBI", name), envir = class_env)
    methods::setMethod(name, signature, definition, where = class_env)
    registered[[length(registered) + 1L]] <<- list(name, signature)
  }
  on.exit({
    for (entry in registered) methods::removeMethod(entry[[1L]], entry[[2L]], where = class_env)
    methods::removeClass("dataview_dbi_test_result", where = class_env)
    methods::removeClass("dataview_dbi_test", where = class_env)
    rm(
      list = "dbplyr_edition.dataview_dbi_test",
      envir = get(".__S3MethodsTable__.", envir = asNamespace("dbplyr"))
    )
  }, add = TRUE)
  con <- methods::new("dataview_dbi_test")
  calls <- character()
  fail <- FALSE
  result_statement <- NULL
  result_next <- NULL
  result_open <- FALSE
  fixture <- data.frame(
    id = seq_len(6010L),
    " day " = rep(as.Date(c("2024-02-29", NA_character_)), 3005L),
    event = rep(as.POSIXct("2024-02-29 12:34:56", tz = "UTC"), 6010L),
    precise = "2024-02-29T23:59:59.1234567",
    offset = "2024-02-29T12:34:56.1234567+11:00",
    clock = "12:34:56.1234567",
    note = "2024-02-29 is ordinary text",
    flag = rep(c(TRUE, FALSE), 3005L),
    check.names = FALSE
  )
  fixture$event[[1L]] <- fixture$event[[1L]] + 0.125
  fixture$event[[2L]] <- NA
  if (requireNamespace("bit64", quietly = TRUE)) {
    fixture$big <- bit64::as.integer64(rep("9007199254740993", nrow(fixture)))
  }
  method("dbIsValid", "dataview_dbi_test", function(dbObj, ...) TRUE)
  method("dbGetInfo", "dataview_dbi_test", function(dbObj, ...) list(dbms.name = "Generic database"))
  method("dbListFields", c("dataview_dbi_test", "character"), function(conn, name, ...) {
    names(fixture)
  })
  method("dbQuoteIdentifier", c("dataview_dbi_test", "character"), function(conn, x, ...) {
    DBI::dbQuoteIdentifier(DBI::ANSI(), x)
  })
  method("dbQuoteLiteral", c("dataview_dbi_test", "ANY"), function(conn, x, ...) {
    DBI::dbQuoteLiteral(DBI::ANSI(), x)
  })
  method("dbGetQuery", c("dataview_dbi_test", "character"), function(conn, statement, ...) {
    calls <<- c(calls, statement)
    if (isTRUE(fail)) stop("test database failure")
    if (identical(fail, "interrupt")) {
      stop(structure(list(message = "cancelled", call = NULL), class = c("interrupt", "condition")))
    }
    if (grepl("WHERE (0 = 1)", statement, fixed = TRUE)) return(fixture[0L, , drop = FALSE])
    stop("unexpected dbGetQuery")
  })
  method("dbSendQuery", c("dataview_dbi_test", "character"), function(conn, statement, ...) {
    calls <<- c(calls, statement)
    if (isTRUE(fail)) stop("test database failure")
    if (identical(fail, "interrupt")) {
      stop(structure(list(message = "cancelled", call = NULL), class = c("interrupt", "condition")))
    }
    result_statement <<- statement
    result_next <<- 1L
    result_open <<- TRUE
    methods::new("dataview_dbi_test_result")
  })
  method("dbFetch", "dataview_dbi_test_result", function(res, n = -1, ...) {
    if (isTRUE(fail)) stop("test database failure")
    if (identical(fail, "interrupt")) {
      stop(structure(list(message = "cancelled", call = NULL), class = c("interrupt", "condition")))
    }
    positions <- seq_along(fixture)
    last <- min(nrow(fixture), result_next + n - 1L)
    rows <- if (result_next > last) integer() else seq.int(result_next, last)
    result_next <<- last + 1L
    fixture[rows, positions, drop = FALSE]
  })
  method("dbHasCompleted", "dataview_dbi_test_result", function(res, ...) {
    result_next > nrow(fixture)
  })
  method("dbClearResult", "dataview_dbi_test_result", function(res, ...) {
    result_statement <<- NULL
    result_next <<- NULL
    result_open <<- FALSE
    TRUE
  })

  tbl <- dplyr::tbl(con, "fixture")
  env <- sess:::.sess_env
  old <- env$dataviews
  on.exit(env$dataviews <- old, add = TRUE)
  original_fixture <- fixture
  fixture <- fixture[rep(seq_len(nrow(fixture)), length.out = 25010L), , drop = FALSE]
  fixture$id <- seq_len(nrow(fixture))
  queries <- list(tbl, dplyr::filter(tbl, id > 0L), dplyr::arrange(tbl, dplyr::desc(id)))
  for (query in queries) local({
    view <- sess:::dataview_register(query)
    on.exit(sess:::handle_dataview_dispose(list(
      view_id = view$view_id, state_generation = view$state_generation
    )), add = TRUE)
    init <- sess:::handle_dataview_init(list(view_id = view$view_id))
    expect_null(init$totalRows)
    expect_true(init$columnProjection)
    expect_true(all(vapply(init$columns, function(column) {
      isFALSE(column$filter) && isFALSE(column$sortable)
    }, logical(1))))
    page <- function(start = 0L, end = 2L, fields = "1", controls = list()) {
      sess:::handle_dataview_page(c(list(
        view_id = view$view_id, startRow = start, endRow = end, fields = fields
      ), controls))
    }
    before <- length(calls)
    first <- page()
    expect_identical(first$rows[["1"]], 1:2)
    expect_identical(first$lastRow, -1L)
    expect_identical(tail(calls, 1L), as.character(dbplyr::sql_render(query)))
    expect_equal(length(calls), before + 1L)
    controls <- list(
      sortModel = list(list(colId = "1", sort = "desc")),
      filterModel = list("1" = list(type = "lessThan", filter = 0L))
    )
    expect_identical(page(controls = controls), first)
    expect_identical(page(100L, 102L, "7")$rows[["7"]], fixture$note[101:102])
    expect_equal(length(calls), before + 1L)
    expect_identical(names(page(fields = "0")$rows), "0")
    expect_equal(nrow(page(10L, 10L)$rows), 0L)
    last <- page(25000L, 25020L)
    expect_identical(last$rows[["1"]], 25001:25010)
    expect_equal(last$totalRows, 25010L)
    expect_equal(last$lastRow, 25010L)
    expect_false(result_open)
    cache <- sess:::dataview_get_state(view$view_id)$dbi_cache
    expect_true(any(vapply(cache$result_cache_blocks, function(block) {
      !is.null(block$path) && file.exists(block$path)
    }, logical(1))))
    expect_identical(page()$rows, first$rows)
    expect_equal(length(calls), before + 1L)
    expect_equal(nrow(page(26000L, 26010L)$rows), 0L)
    # Dates, timestamps, NULLs and exact bigint survive spilling and projection.
    rows <- page(fields = c("2", "3", "9"))$rows
    wire <- jsonlite::fromJSON(jsonlite::toJSON(rows, na = "null", digits = NA))
    expect_identical(wire[["2"]][[1L]], "2024-02-29")
    expect_true(is.na(wire[["2"]][[2L]]))
    expect_identical(wire[["3"]][[1L]], "2024-02-29T12:34:56.125")
    if ("9" %in% names(wire)) expect_identical(wire[["9"]][[1L]], "9007199254740993")
    cache_dir <- cache$result_cache_dir
    sess:::handle_dataview_dispose(list(
      view_id = view$view_id, state_generation = view$state_generation
    ))
    expect_false(dir.exists(cache_dir))
    expect_true(DBI::dbIsValid(con))
  })

  for (failure in list(TRUE, "interrupt")) local({
    view <- sess:::dataview_register(tbl)
    on.exit({
      fail <<- FALSE
      sess:::handle_dataview_dispose(list(
        view_id = view$view_id, state_generation = view$state_generation
      ))
    }, add = TRUE)
    page <- function(start, end) sess:::handle_dataview_page(list(
      view_id = view$view_id, startRow = start, endRow = end, fields = "1"
    ))
    page(20000L, 20002L)
    cache <- sess:::dataview_get_state(view$view_id)$dbi_cache
    spilled <- list.files(cache$result_cache_dir, full.names = TRUE)
    expect_true(length(spilled) > 0L)
    fail <<- failure
    caught <- tryCatch(page(25000L, 25002L), error = identity, interrupt = identity)
    fail <<- FALSE
    expect_true(inherits(caught, if (isTRUE(failure)) "error" else "interrupt"))
    expect_false(result_open)
    expect_equal(cache$result_cache_rows, 0L)
    expect_length(cache$result_cache_blocks, 0L)
    expect_false(cache$result_complete)
    expect_false(any(file.exists(spilled)))
    expect_identical(page(6000L, 6002L)$rows[["1"]], 6001:6002)
    expect_identical(page(0L, 2L)$rows[["1"]], 1:2)
    expect_true(DBI::dbIsValid(con))
  })
})

# Execute actual SQL through a non-SQL Server DBI driver.
if (requireNamespace("RSQLite", quietly = TRUE) &&
      requireNamespace("arrow", quietly = TRUE) &&
      requireNamespace("dbplyr", quietly = TRUE)) local({
  con <- DBI::dbConnect(RSQLite::SQLite(), ":memory:")
  on.exit(DBI::dbDisconnect(con), add = TRUE)
  fixture <- data.frame(id = 1:12, label = rep(c("b", "a", NA), 4L))
  DBI::dbWriteTable(con, "odd table", fixture)
  tbl <- dplyr::tbl(con, "odd table")
  queries <- list(
    tbl,
    tbl |> dplyr::filter(id > 3L) |> dplyr::arrange(dplyr::desc(id)),
    tbl |> dplyr::group_by(label) |> dplyr::summarise(total = sum(id, na.rm = TRUE)) |>
      dplyr::arrange(dplyr::desc(total)),
    head(dplyr::arrange(tbl, dplyr::desc(id)), 3L),
    dplyr::filter(tbl, id < 0L)
  )
  for (query in queries) local({
    expected <- as.data.frame(dplyr::collect(query))
    view <- sess:::dataview_register(query)
    on.exit(sess:::handle_dataview_dispose(list(
      view_id = view$view_id, state_generation = view$state_generation
    )), add = TRUE)
    init <- sess:::handle_dataview_init(list(view_id = view$view_id))
    wire <- jsonlite::fromJSON(jsonlite::toJSON(init))
    expect_true(all(wire$columns$filter == FALSE))
    expect_true(all(wire$columns$sortable == FALSE))
    result <- sess:::handle_dataview_page(list(
      view_id = view$view_id, startRow = 0L, endRow = 20L,
      sortModel = list(list(colId = "1", sort = "desc")),
      filterModel = list("1" = list(type = "lessThan", filter = -1L))
    ))
    actual <- result$rows[, -1L, drop = FALSE]
    names(actual) <- names(expected)
    rownames(actual) <- rownames(expected) <- NULL
    expect_equal(actual, expected)
    expect_equal(result$lastRow, nrow(expected))
    expect_true(DBI::dbIsValid(con))
  })
})
