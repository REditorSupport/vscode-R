if (requireNamespace("DBI", quietly = TRUE) &&
      requireNamespace("dbplyr", quietly = TRUE) &&
      requireNamespace("dplyr", quietly = TRUE)) local({
  con <- dbplyr::simulate_mssql()
  render <- function(table) {
    as.character(dbplyr::sql_render(sess:::dataview_dbi_primary_key_query(con, table)))
  }
  sql <- render("fixture")
  expect_true(grepl("FROM [sys].[indexes]", sql, fixed = TRUE))
  expect_true(grepl("OBJECT_ID('[fixture]', 'U')", sql, fixed = TRUE))
  expect_true(grepl("[is_primary_key] = 1", sql, fixed = TRUE))
  expect_true(grepl("[key_ordinal] > 0", sql, fixed = TRUE))
  expect_true(grepl("ORDER BY [key_ordinal]", sql, fixed = TRUE))
  # Match both object and index ids; unrelated indexes can have the same index id.
  expect_true(grepl("[object_id] = [index_columns].[object_id]", sql, fixed = TRUE))
  expect_true(grepl("[index_id] = [index_columns].[index_id]", sql, fixed = TRUE))
  expect_true(grepl("[object_id] = [columns].[object_id]", sql, fixed = TRUE))
  expect_true(grepl("[column_id] = [columns].[column_id]", sql, fixed = TRUE))

  sql <- render(DBI::Id(schema = "custom schema", table = "O'Brien]table"))
  expect_true(grepl("OBJECT_ID('[custom schema].[O''Brien]]table]', 'U')", sql, fixed = TRUE))
  expect_true(grepl("FROM [sys].[indexes]", sql, fixed = TRUE))

  sql <- render(DBI::Id(catalog = "odd]db", schema = "dbo", table = "fixture"))
  for (view in c("indexes", "index_columns", "columns")) {
    expect_true(grepl(paste0("[odd]]db].[sys].[", view, "]"), sql, fixed = TRUE))
  }
  expect_true(grepl("OBJECT_ID('[odd]]db].[dbo].[fixture]', 'U')", sql, fixed = TRUE))
})

# Exercise collection and the permission/no-key fallbacks through DBI dispatch.
if (requireNamespace("DBI", quietly = TRUE) &&
      requireNamespace("dbplyr", quietly = TRUE) &&
      requireNamespace("dplyr", quietly = TRUE)) local({
  class_env <- environment()
  methods::setClass("dataview_pk_test", contains = "DBIConnection", where = class_env)
  methods::setClass("dataview_pk_result", contains = "DBIResult", where = class_env)
  registerS3method(
    "dbplyr_edition", "dataview_pk_test", function(con) 2L, envir = asNamespace("dbplyr")
  )
  registered <- list()
  method <- function(name, signature, definition) {
    assign(name, getExportedValue("DBI", name), envir = class_env)
    methods::setMethod(name, signature, definition, where = class_env)
    registered[[length(registered) + 1L]] <<- list(name, signature)
  }
  on.exit({
    for (entry in registered) methods::removeMethod(entry[[1L]], entry[[2L]], where = class_env)
    methods::removeClass("dataview_pk_result", where = class_env)
    methods::removeClass("dataview_pk_test", where = class_env)
    rm(
      "dbplyr_edition.dataview_pk_test",
      envir = get(".__S3MethodsTable__.", envir = asNamespace("dbplyr"))
    )
  }, add = TRUE)
  keys <- c("tenant_id", "record_id")
  denied <- FALSE
  statements <- character()
  cleared <- 0L
  method("dbQuoteIdentifier", c("dataview_pk_test", "character"), function(conn, x, ...) {
    DBI::dbQuoteIdentifier(DBI::ANSI(), x)
  })
  method("dbQuoteLiteral", c("dataview_pk_test", "ANY"), function(conn, x, ...) {
    DBI::dbQuoteLiteral(DBI::ANSI(), x)
  })
  method("dbSendQuery", c("dataview_pk_test", "character"), function(conn, statement, ...) {
    if (denied) stop("metadata permission denied")
    statements <<- c(statements, statement)
    methods::new("dataview_pk_result")
  })
  method("dbFetch", "dataview_pk_result", function(res, n = -1, ...) {
    data.frame(column_name = keys)
  })
  method("dbHasCompleted", "dataview_pk_result", function(res, ...) TRUE)
  method("dbClearResult", "dataview_pk_result", function(res, ...) {
    cleared <<- cleared + 1L
    TRUE
  })
  con <- methods::new("dataview_pk_test")
  expect_identical(sess:::dataview_dbi_primary_key(con, "fixture"), keys)
  expect_length(statements, 1L)
  expect_equal(cleared, 1L)
  keys <- character()
  expect_identical(sess:::dataview_dbi_primary_key(con, "fixture"), character())
  expect_equal(cleared, 2L)
  denied <- TRUE
  expect_identical(sess:::dataview_dbi_primary_key(con, "fixture"), character())
})
