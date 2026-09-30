# Record real DBI calls without requiring a SQL Server or credentials. SQL Server
# execution/driver behavior still needs integration testing against that server.
if (requireNamespace("DBI", quietly = TRUE) && requireNamespace("dbplyr", quietly = TRUE)) local({
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
      "dbplyr_edition.dataview_dbi_test",
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
  method("dbGetInfo", "dataview_dbi_test", function(dbObj, ...) list(dbms.name = "SQL Server"))
  method("dbListFields", c("dataview_dbi_test", "character"), function(conn, name, ...) {
    names(fixture)
  })
  method("dbQuoteIdentifier", c("dataview_dbi_test", "character"), function(conn, x, ...) {
    DBI::SQL(paste0("[", gsub("]", "]]", x, fixed = TRUE), "]"))
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
    if (grepl("select top (0)", statement, fixed = TRUE)) return(fixture[0L, , drop = FALSE])
    if (grepl("WHERE (0 = 1)", statement, fixed = TRUE)) return(fixture[0L, , drop = FALSE])
    if (grepl("select count_big(*)", statement, fixed = TRUE)) return(data.frame(n = nrow(fixture)))
    stop("unexpected dbGetQuery")
  })
  method("dbSendQuery", c("dataview_dbi_test", "character"), function(conn, statement, ...) {
    calls <<- c(calls, statement)
    if (isTRUE(fail)) stop("test database failure")
    if (identical(fail, "interrupt")) {
      stop(structure(list(message = "cancelled", call = NULL), class = c("interrupt", "condition")))
    }
    result_statement <<- statement
    result_next <<- as.integer(sub(".* offset ([0-9]+) rows.*", "\\1", statement)) + 1L
    result_open <<- TRUE
    methods::new("dataview_dbi_test_result")
  })
  method("dbFetch", "dataview_dbi_test_result", function(res, n = -1, ...) {
    if (isTRUE(fail)) stop("test database failure")
    if (identical(fail, "interrupt")) {
      stop(structure(list(message = "cancelled", call = NULL), class = c("interrupt", "condition")))
    }
    projection <- strsplit(result_statement, " from ", fixed = TRUE)[[1L]][[1L]]
    positions <- which(vapply(names(fixture), function(name) {
      grepl(paste0("dataview_source.[", name, "]"), projection, fixed = TRUE)
    }, logical(1)))
    last <- min(nrow(fixture), result_next + n - 1L)
    rows <- if (result_next > last) integer() else seq.int(result_next, last)
    result_next <<- last + 1L
    fixture[rows, positions, drop = FALSE]
  })
  method("dbClearResult", "dataview_dbi_test_result", function(res, ...) {
    result_statement <<- NULL
    result_next <<- NULL
    result_open <<- FALSE
    TRUE
  })

  tbl <- dplyr::tbl(con, "fixture")
  expect_true(sess:::dataview_is_table(tbl))
  state <- sess:::dataview_to_state(tbl)
  expect_true(grepl("[fixture]", state$dbi$from_sql, fixed = TRUE))
  expect_false(grepl("select", state$dbi$from_sql, ignore.case = TRUE))
  expect_equal(state$total_rows, nrow(fixture))
  expect_identical(state$column_names, names(fixture))
  expect_equal(as.character(state$columns[[3L]]$type), "dateColumn")
  expect_equal(as.character(state$columns[[4L]]$type), "datetimeColumn")
  for (i in 5:8) expect_equal(as.character(state$columns[[i]]$type), "textColumn")
  expect_identical(sess:::dataview_dbi_identifier(state, "2"), "[ day ]")
  sort <- list(list(colId = "1", sort = "asc"))
  fetch <- function(start = 0L, end = 10L, fields = NULL, filters = list(), order = sort) {
    sess:::dataview_dbi_page(state, start, end, order, filters, fields)
  }
  page <- fetch(fields = c("2", "3", "4", "5", "6", "8"))
  expect_identical(names(page$rows), c("0", "2", "3", "4", "5", "6", "8"))
  expect_identical(page$rows[["3"]][[1L]], "2024-02-29T12:34:56.125")
  expect_identical(page$rows[["4"]][[1L]], "2024-02-29T23:59:59.1234567")
  expect_identical(page$rows[["5"]][[1L]], "2024-02-29T12:34:56.1234567+11:00")
  expect_true(is.na(page$rows[["3"]][[2L]]))
  expect_identical(page$rows[["8"]][1:2], c(TRUE, FALSE))
  sql <- tail(calls, 1L)
  expect_true(grepl("dataview_source.[event]", sql, fixed = TRUE))
  expect_false(grepl("convert(varchar(48)", sql, fixed = TRUE))
  expect_true(grepl(
    "order by case when dataview_source.[id] is null then 1 else 0 end, dataview_source.[id] asc",
    sql,
    fixed = TRUE
  ))
  expect_true(grepl("offset 0 rows", sql, fixed = TRUE))
  expect_false(grepl("fetch next", sql, fixed = TRUE))
  expect_false(grepl("dataview_source.[note]", sql, fixed = TRUE))
  before <- length(calls)
  fetch(fields = c("8", "6", "5", "4", "3", "2", "2"))
  expect_equal(length(calls), before) # reorder/deduplicate fields without another query

  before <- length(calls)
  page <- fetch(900L, 1100L, "1", order = list())
  expect_identical(page$rows[["1"]], 901:1100)
  expect_identical(page$rows[["0"]], 901:1100)
  expect_equal(length(calls), before + 1L) # one cursor, two sequential dbFetch() blocks
  before <- length(calls)
  fetch(0L, 10L, "1", order = list())
  expect_equal(length(calls), before) # cached backward scroll
  for (start in c(2000L, 3000L, 4000L, 5000L)) {
    fetch(start, start + 10L, "1", order = list())
  }
  expect_equal(length(state$dbi_cache$blocks), 6L)
  before <- length(calls)
  fetch(0L, 10L, "1", order = list())
  expect_equal(length(calls), before) # retained within the 20,000-row cache
  before <- length(calls)
  expect_identical(names(fetch(fields = list())$rows), "0")
  expect_equal(nrow(fetch(fields = "0")$rows), 10L)
  expect_equal(nrow(fetch(6010L, 6020L)$rows), 0L)
  expect_equal(nrow(fetch(10L, 10L)$rows), 0L)
  expect_equal(length(calls), before)
  expect_identical(fetch(6000L, 6020L, "1")$rows[["1"]], 6001:6010)

  cache_state <- sess:::dataview_dbi_cache_state()
  for (block_start in seq(1L, 21001L, by = 1000L)) {
    sess:::dataview_dbi_cache_add(
      cache_state, block_start, data.frame(id = seq_len(1000L))
    )
  }
  expect_equal(length(cache_state$blocks), 20L)
  expect_null(cache_state$blocks[["1"]])
  expect_false(is.null(sess:::dataview_dbi_cache_get(cache_state, 2001L)))
  expect_identical(tail(names(cache_state$blocks), 1L), "2001")

  # A failed fetch must not attach the new query key to stale data.
  fetch(fields = "1")
  fail <- TRUE
  expect_error(fetch(fields = "3"), "test database failure")
  fail <- FALSE
  expect_identical(names(fetch(fields = "3")$rows), c("0", "3"))
  filters <- list("3" = list(
    filterType = "date", type = "equals", dateFrom = "2024-02-29 00:00:00"
  ))
  fail <- TRUE
  expect_error(fetch(filters = filters), "test database failure")
  fail <- FALSE
  before <- length(calls)
  fetch(filters = filters)
  expect_equal(length(calls), before + 2L) # count retried as well as page
  before <- length(calls)
  fetch(fields = "3", filters = filters, order = list(list(colId = "1", sort = "desc")))
  expect_equal(length(calls), before + 1L) # sort/projection does not recount

  condition <- function(type, field = "3") {
    sess:::dataview_dbi_filter_sql(state, setNames(list(list(
      type = type, dateFrom = "2024-02-29 00:00:00", dateTo = "2024-03-01 00:00:00"
    )), field))
  }
  expect_identical(
    condition("equals"),
    " where ([event] = convert(datetime2, '2024-02-29T00:00:00', 126))"
  )
  expect_identical(
    condition("inRange"),
    paste0(
      " where ([event] >= convert(datetime2, '2024-02-29T00:00:00', 126) and ",
      "[event] <= convert(datetime2, '2024-03-01T00:00:00', 126))"
    )
  )
  expect_identical(condition("blank"), " where ([event] is null)")
  expect_identical(condition("notBlank"), " where ([event] is not null)")
  expect_identical(
    condition("inRange", "2"),
    paste0(
      " where ([ day ] >= convert(date, '20240229', 112) and ",
      "[ day ] <= convert(date, '20240301', 112))"
    )
  )
  bad <- list("3" = list(type = "equals", dateFrom = "not a date"))
  expect_error(fetch(filters = bad), "Invalid database date filter")
  expect_identical(sess:::dataview_dbi_filter_sql(state, list(
    "7" = list(type = "equals", filter = "O'Brien")
  )), " where (lower(cast([note] as nvarchar(max))) = 'o''brien')")
  expect_identical(sess:::dataview_dbi_filter_sql(state, list(
    "7" = list(type = "blank")
  )), " where (([note] is null or ltrim(rtrim(cast([note] as nvarchar(max)))) = ''))")
  expect_identical(sess:::dataview_dbi_filter_sql(state, list(
    "7" = list(type = "contains", filter = "TEXT")
  )), " where (charindex('text', lower(cast([note] as nvarchar(max)))) > 0)")

  arranged <- dplyr::arrange(tbl, dplyr::desc(id))
  expect_silent(arranged_state <- sess:::dataview_to_state(arranged))
  expect_false(grepl("ORDER BY", arranged_state$dbi$from_sql, fixed = TRUE))
  expect_identical(arranged_state$dbi$source_order, "[id] DESC")
  expect_identical(
    sess:::dataview_dbi_order_sql(arranged_state, list()),
    " order by [id] DESC"
  )
  expect_identical(
    sess:::dataview_dbi_order_sql(arranged_state, sort),
    paste0(
      " order by case when dataview_source.[id] is null then 1 else 0 end, ",
      "dataview_source.[id] asc"
    )
  )
  expect_identical(
    sess:::dataview_dbi_order_sql(
      arranged_state, list(list(colId = "1", sort = "desc"))
    ),
    paste0(
      " order by case when dataview_source.[id] is null then 1 else 0 end, ",
      "dataview_source.[id] desc"
    )
  )

  filtered_arranged <- tbl |>
    dplyr::filter(flag) |>
    dplyr::arrange(dplyr::desc(id))
  expect_silent(filtered_arranged_state <- sess:::dataview_to_state(filtered_arranged))
  expect_false(grepl("ORDER BY", filtered_arranged_state$dbi$from_sql, fixed = TRUE))
  expect_true(grepl("WHERE [flag]", filtered_arranged_state$dbi$from_sql, fixed = TRUE))
  expect_identical(filtered_arranged_state$dbi$source_order, "[id] DESC")

  # arrange() can be inherited through later filter/select operations.
  inherited_arranged <- arranged |>
    dplyr::filter(flag) |>
    dplyr::select(id, flag)
  expect_silent(inherited_arranged_state <- sess:::dataview_to_state(inherited_arranged))
  expect_false(grepl("ORDER BY", inherited_arranged_state$dbi$from_sql, fixed = TRUE))
  expect_identical(inherited_arranged_state$dbi$source_order, "[id] DESC")

  grouped_arranged <- tbl |>
    dplyr::group_by(flag) |>
    dplyr::arrange(dplyr::desc(id), .by_group = TRUE)
  expect_silent(grouped_arranged_state <- sess:::dataview_to_state(grouped_arranged))
  expect_false(grepl("ORDER BY", grouped_arranged_state$dbi$from_sql, fixed = TRUE))
  expect_identical(grouped_arranged_state$dbi$source_order, c("[flag]", "[id] DESC"))
  expect_identical(
    sess:::dataview_dbi_order_sql(
      grouped_arranged_state, list(list(colId = "2", sort = "asc"))
    ),
    paste0(
      " order by case when dataview_source.[flag] is null then 1 else 0 end, ",
      "dataview_source.[flag] asc, [id] DESC"
    )
  )

  # Exercise handler routing and JSON serialization, including nulls and exact bigint.
  env <- sess:::.sess_env
  old <- env$dataviews
  on.exit(env$dataviews <- old, add = TRUE)
  view <- sess:::dataview_register(tbl)
  expect_true(sess:::handle_dataview_init(list(view_id = view$view_id))$columnProjection)
  result <- sess:::handle_dataview_page(list(
    view_id = view$view_id, startRow = 0L, endRow = 2L, fields = c("2", "3", "9")
  ))
  wire <- jsonlite::fromJSON(jsonlite::toJSON(result$rows, na = "null", digits = NA))
  expect_identical(wire[["2"]][[1L]], "2024-02-29")
  expect_true(is.na(wire[["2"]][[2L]]))
  expect_true(is.na(wire[["3"]][[2L]]))
  if ("9" %in% names(wire)) expect_identical(wire[["9"]][[1L]], "9007199254740993")
  expect_true(result_open)
  expect_true(sess:::handle_dataview_dispose(list(view_id = view$view_id)))
  expect_false(result_open)
  expect_true(DBI::dbIsValid(con)) # the viewer does not own the connection

  # An interrupted page must reply, clear its busy notification, and allow the
  # next RPC to run. The DBI connection belongs to the user and remains usable.
  view <- sess:::dataview_register(tbl)
  pipe <- processx::conn_create_pipepair()
  old_con <- env$con
  on.exit({
    env$con <- old_con
    lapply(pipe, close)
  }, add = TRUE)
  env$con <- pipe[[2L]]
  fail <- "interrupt"
  sess:::dispatch_message(as.character(jsonlite::toJSON(list(
    jsonrpc = "2.0", id = "cancel", method = "dataview_page",
    params = list(view_id = view$view_id, startRow = 0L, endRow = 2L, notify_busy = TRUE)
  ), auto_unbox = TRUE)))
  messages <- lapply(
    strsplit(trimws(processx::conn_read_chars(pipe[[1L]])), "\n")[[1L]], jsonlite::fromJSON
  )
  expect_identical(messages[[1L]]$method, "dataview_busy")
  expect_identical(messages[[1L]]$params$view_id, view$view_id)
  expect_equal(messages[[2L]]$error$code, -32800L)
  expect_identical(messages[[3L]]$method, "dataview_busy")
  expect_null(messages[[3L]]$params$view_id)
  fail <- FALSE
  sess:::dispatch_message(as.character(jsonlite::toJSON(list(
    jsonrpc = "2.0", id = "after-cancel", method = "dataview_page",
    params = list(view_id = view$view_id, startRow = 0L, endRow = 2L)
  ), auto_unbox = TRUE)))
  reply <- jsonlite::fromJSON(processx::conn_read_chars(pipe[[1L]]))
  expect_identical(reply$id, "after-cancel")
  expect_equal(nrow(reply$result$rows), 2L)
  expect_true(DBI::dbIsValid(con))
  env$con <- old_con

})
