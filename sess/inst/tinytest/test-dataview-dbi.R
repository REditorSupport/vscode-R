# Record real DBI calls without requiring a SQL Server or credentials. SQL Server
# execution/driver behavior still needs integration testing against that server.
if (requireNamespace("DBI", quietly = TRUE) && requireNamespace("dbplyr", quietly = TRUE)) local({
  class_env <- environment()
  methods::setClass("dataview_dbi_test", contains = "DBIConnection", where = class_env)
  registerS3method("dbplyr_edition", "dataview_dbi_test", function(con) 2L,
    envir = asNamespace("dbplyr"))
  registered <- list()
  method <- function(name, signature, definition) {
    assign(name, getExportedValue("DBI", name), envir = class_env)
    methods::setMethod(name, signature, definition, where = class_env)
    registered[[length(registered) + 1L]] <<- list(name, signature)
  }
  on.exit({
    for (entry in registered) methods::removeMethod(entry[[1L]], entry[[2L]], where = class_env)
    methods::removeClass("dataview_dbi_test", where = class_env)
    rm("dbplyr_edition.dataview_dbi_test",
      envir = get(".__S3MethodsTable__.", envir = asNamespace("dbplyr")))
  }, add = TRUE)
  con <- methods::new("dataview_dbi_test")
  calls <- character()
  fail <- FALSE
  metadata_available <- TRUE
  fixture <- data.frame(
    id = seq_len(6010L),
    " day " = rep(c("2024-02-29", NA_character_), 3005L),
    event = "2024-02-29T12:34:56.123",
    precise = "2024-02-29T23:59:59.1234567",
    offset = "2024-02-29T12:34:56.1234567+11:00",
    clock = "12:34:56.1234567",
    note = "2024-02-29 is ordinary text",
    flag = rep(c(TRUE, FALSE), 3005L),
    check.names = FALSE
  )
  fixture$event[[2L]] <- NA_character_
  types <- c(
    "int", "date", "datetime", "datetime2(7)", "datetimeoffset(7)",
    "time(7)", "nvarchar(100)", "bit"
  )
  if (requireNamespace("bit64", quietly = TRUE)) {
    fixture$big <- bit64::as.integer64(rep("9007199254740993", nrow(fixture)))
    types <- c(types, "bigint")
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
    if (grepl("select top (0)", statement, fixed = TRUE)) return(fixture[0L, , drop = FALSE])
    if (grepl("WHERE (0 = 1)", statement, fixed = TRUE)) return(fixture[0L, , drop = FALSE])
    if (grepl("sys.dm_exec_describe_first_result_set", statement, fixed = TRUE)) {
      if (!metadata_available) stop("metadata unavailable")
      return(data.frame(column_ordinal = seq_along(types), system_type_name = types))
    }
    if (grepl("select count_big(*)", statement, fixed = TRUE)) return(data.frame(n = nrow(fixture)))
    start <- as.integer(sub(".* offset ([0-9]+) rows.*", "\\1", statement))
    n <- as.integer(sub(".* fetch next ([0-9]+) rows only.*", "\\1", statement))
    projection <- strsplit(statement, " from (", fixed = TRUE)[[1L]][[1L]]
    positions <- which(vapply(names(fixture), function(name) {
      grepl(paste0("dataview_source.[", name, "]"), projection, fixed = TRUE)
    }, logical(1)))
    fixture[seq.int(start + 1L, length.out = n), positions, drop = FALSE]
  })

  tbl <- dplyr::tbl(con, "fixture")
  expect_true(sess:::dataview_is_table(tbl))
  state <- sess:::dataview_to_state(tbl)
  expect_true(grepl("^select \\* from ", state$dbi$query_sql, ignore.case = TRUE))
  expect_true(grepl("[fixture]", state$dbi$from_sql, fixed = TRUE))
  expect_false(grepl("select", state$dbi$from_sql, ignore.case = TRUE))
  expect_equal(state$total_rows, nrow(fixture))
  expect_identical(state$column_names, names(fixture))
  expect_equal(as.character(state$columns[[3L]]$type), "dateColumn")
  for (i in 4:6) expect_equal(as.character(state$columns[[i]]$type), "datetimeColumn")
  expect_equal(as.character(state$columns[[8L]]$type), "textColumn")
  expect_identical(sess:::dataview_dbi_identifier(state, "2"), "[ day ]")
  sort <- list(list(colId = "1", sort = "asc"))
  fetch <- function(start = 0L, end = 10L, fields = NULL, filters = list(), order = sort) {
    sess:::dataview_dbi_page(state, start, end, order, filters, fields)
  }
  page <- fetch(fields = c("2", "3", "4", "5", "6", "8"))
  expect_identical(names(page$rows), c("0", "2", "3", "4", "5", "6", "8"))
  expect_identical(page$rows[["4"]][[1L]], "2024-02-29T23:59:59.1234567")
  expect_identical(page$rows[["5"]][[1L]], "2024-02-29T12:34:56.1234567+11:00")
  expect_true(is.na(page$rows[["3"]][[2L]]))
  expect_identical(page$rows[["8"]][1:2], c(TRUE, FALSE))
  sql <- tail(calls, 1L)
  expect_true(grepl(
    "convert(varchar(48), dataview_source.[event], 126) as [event]", sql, fixed = TRUE
  ))
  expect_true(grepl("order by dataview_source.[id] asc", sql, fixed = TRUE))
  expect_false(grepl("dataview_source.[note]", sql, fixed = TRUE))
  before <- length(calls)
  fetch(fields = c("8", "6", "5", "4", "3", "2", "2"))
  expect_equal(length(calls), before) # reorder/deduplicate fields without another query

  page <- fetch(900L, 1100L, "1")
  expect_identical(page$rows[["1"]], 901:1100)
  expect_identical(page$rows[["0"]], 901:1100)
  before <- length(calls)
  fetch(0L, 10L, "1")
  expect_equal(length(calls), before) # cached backward scroll
  for (start in c(2000L, 3000L, 4000L, 5000L)) fetch(start, start + 10L, "1")
  expect_equal(length(state$dbi_cache$blocks), 4L)
  before <- length(calls)
  fetch(0L, 10L, "1")
  expect_equal(length(calls), before + 1L) # oldest block evicted
  before <- length(calls)
  expect_identical(names(fetch(fields = list())$rows), "0")
  expect_equal(nrow(fetch(fields = "0")$rows), 10L)
  expect_equal(nrow(fetch(6010L, 6020L)$rows), 0L)
  expect_equal(nrow(fetch(10L, 10L)$rows), 0L)
  expect_equal(length(calls), before)
  expect_identical(fetch(6000L, 6020L, "1")$rows[["1"]], 6001:6010)

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
  expect_equal(condition("equals"), paste0(
    " where (([event] >= convert(date, '20240229', 112) and ",
    "[event] < dateadd(day, 1, convert(date, '20240229', 112))))"
  ))
  expect_true(grepl(" or ", condition("notEqual"), fixed = TRUE))
  expect_true(grepl(
    "< dateadd(day, 1, convert(date, '20240301', 112))", condition("inRange"), fixed = TRUE
  ))
  expect_identical(condition("blank"), " where ([event] is null)")
  expect_identical(condition("notBlank"), " where ([event] is not null)")
  expect_true(grepl("cast([offset] as date)", condition("equals", "5"), fixed = TRUE))
  bad <- list("3" = list(type = "equals", dateFrom = "not a date"))
  expect_error(fetch(filters = bad), "Invalid database date filter")
  expect_identical(sess:::dataview_dbi_filter_sql(state, list(
    "7" = list(type = "equals", filter = "O'Brien")
  )), " where ([note] = 'O''Brien')")

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
  expect_true(sess:::handle_dataview_dispose(list(view_id = view$view_id)))
  expect_true(DBI::dbIsValid(con)) # the viewer does not own the connection

  # Metadata failure preserves genuine R Date/POSIXct classes without guessing text.
  metadata_available <- FALSE
  fixture$event <- as.POSIXct(rep("2024-02-29 12:34:50", nrow(fixture)), tz = "Australia/Sydney")
  fixture$event[[1L]] <- fixture$event[[1L]] + 0.125
  fixture[[" day "]] <- as.Date(fixture[[" day "]])
  expect_warning(state <- sess:::dataview_to_state(tbl), "metadata is unavailable")
  page <- fetch(fields = c("2", "3"))
  expect_identical(page$rows[["2"]][[1L]], "2024-02-29")
  expect_identical(page$rows[["3"]][[1L]], "2024-02-29T12:34:50.125")
  expect_identical(page$rows[["3"]][[2L]], "2024-02-29T12:34:50")
})
