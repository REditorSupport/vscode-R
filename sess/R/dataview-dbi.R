# Lazy DBI table support for the data viewer

dataview_is_dbi_lazy <- function(data) {
  inherits(data, "tbl_sql")
}

dataview_dbi_cache_block_size <- 1000L
dataview_dbi_cache_blocks <- 4L

dataview_dbi_cache_state <- function() {
  state <- new.env(parent = emptyenv())
  state$filter_key <- NULL
  state$total <- NULL
  state$query_key <- NULL
  state$blocks <- list()
  state
}

dataview_dbi_source <- function(data) {
  if (!requireNamespace("DBI", quietly = TRUE) ||
        !requireNamespace("dbplyr", quietly = TRUE)) {
    stop("Viewing lazy database tables requires the optional 'DBI' and 'dbplyr' packages")
  }

  con <- data$src$con
  if (!inherits(con, "DBIConnection") || !DBI::dbIsValid(con)) {
    stop("the lazy table does not have a valid DBI connection")
  }
  if (!inherits(con, "Microsoft SQL Server") &&
        !grepl("SQL Server", DBI::dbGetInfo(con)$dbms.name %||% "", fixed = TRUE)) {
    stop("Lazy database viewing currently supports SQL Server connections")
  }

  # Keep dbplyr's table/query distinction until it has built the FROM source.
  # subquery = TRUE also removes an unbounded ORDER BY that SQL Server would
  # reject inside a derived table.
  query_sql <- as.character(dbplyr::remote_query(data))
  source_sql <- dbplyr::sql_render(data, subquery = TRUE)
  from_sql <- as.character(
    dbplyr::sql_query_wrap(con, source_sql, name = "dataview_source")
  )
  schema <- DBI::dbGetQuery(
    con,
    paste0("select top (0) * from ", from_sql)
  )

  # Drivers can return SQL date/time columns as character. Ask the server once
  # instead of inferring their type from R values (or parsing arbitrary text).
  metadata <- tryCatch(DBI::dbGetQuery(con, paste0(
    "select column_ordinal, system_type_name from ",
    "sys.dm_exec_describe_first_result_set(",
    DBI::dbQuoteLiteral(con, query_sql), ", NULL, 0) where is_hidden = 0"
  )), error = function(e) NULL)
  sql_types <- rep(NA_character_, ncol(schema))
  if (!is.null(metadata)) {
    positions <- match(seq_len(ncol(schema)), metadata$column_ordinal)
    sql_types <- tolower(sub("\\(.*$", "", metadata$system_type_name[positions]))
  }
  if (all(is.na(sql_types))) {
    warning("SQL Server result type metadata is unavailable; using the driver's R column types")
  }
  list(
    con = con,
    query_sql = query_sql,
    from_sql = from_sql,
    schema = schema,
    sql_types = sql_types
  )
}

dataview_dbi_to_state <- function(data) {
  source <- dataview_dbi_source(data)
  total_rows <- DBI::dbGetQuery(
    source$con,
    paste0("select count_big(*) as n from ", source$from_sql)
  )[[1L]][[1L]]
  total_rows <- as.numeric(total_rows)
  if (!is.finite(total_rows) || total_rows < 0 || total_rows > .Machine$integer.max) {
    stop("database result is too large for the current data viewer row index")
  }
  total_rows <- as.integer(total_rows)

  colnames <- names(source$schema)
  headers <- c(" ", trimws(colnames))
  fields <- as.character(seq_along(headers) - 1L)
  cols <- c(
    list(integer()),
    lapply(seq_len(ncol(source$schema)), function(position) source$schema[[position]])
  )
  columns <- .mapply(get_column_def, list(headers, fields, cols), NULL)
  for (position in seq_along(colnames)) {
    type <- source$sql_types[[position]]
    if (type %in% c("date", "datetime", "datetime2", "smalldatetime", "datetimeoffset")) {
      column <- columns[[position + 1L]]
      column$type <- jsonlite::unbox(if (type == "date") "dateColumn" else "datetimeColumn")
      column$filter <- jsonlite::unbox("agDateColumnFilter")
      column$headerTooltip <- jsonlite::unbox(paste0(colnames[[position]], ", SQL type: ", type))
      columns[[position + 1L]] <- column
    }
  }

  list(
    data = data,
    dbi = source,
    row_index = NULL,
    columns = columns,
    column_names = colnames,
    total_rows = total_rows,
    query_key = NULL,
    query_indices = NULL,
    query_has_sort = FALSE,
    dbi_cache = dataview_dbi_cache_state(),
    arrow_reader = NULL
  )
}

dataview_dbi_identifier <- function(state, col_id) {
  position <- dataview_field_position(col_id, length(state$columns))
  if (is.na(position) || position == 1L) {
    return(NULL)
  }
  as.character(DBI::dbQuoteIdentifier(state$dbi$con, state$column_names[[position - 1L]]))
}

dataview_dbi_literal <- function(state, value) {
  as.character(DBI::dbQuoteLiteral(state$dbi$con, value))
}

dataview_dbi_condition <- function(state, column, cond, position) {
  type <- as.character(cond$type %||% "")
  if (!nzchar(type)) return(NULL)
  column_type <- as.character(state$columns[[position]]$type)
  is_date <- column_type %in% c("dateColumn", "datetimeColumn")
  if (is_date && type %in% c("blank", "notBlank")) {
    return(paste0(column, if (type == "blank") " is null" else " is not null"))
  }
  if (type == "blank") {
    return(paste0("(", column, " is null or cast(", column, " as nvarchar(max)) = '')"))
  }
  if (type == "notBlank") {
    return(paste0("(", column, " is not null and cast(", column, " as nvarchar(max)) <> '')"))
  }
  if (type == "true") return(paste0(column, " = 1"))
  if (type == "false") return(paste0(column, " = 0"))

  value <- cond$filter
  if (!is.null(cond$dateFrom)) value <- cond$dateFrom
  value2 <- cond$filterTo
  if (!is.null(cond$dateTo)) value2 <- cond$dateTo

  if (is_date && type %in% c(
    "equals", "notEqual", "greaterThan", "greaterThanOrEqual",
    "lessThan", "lessThanOrEqual", "inRange"
  )) {
    day_literal <- function(value) {
      day <- suppressWarnings(as.Date(substr(as.character(value), 1L, 10L), "%Y-%m-%d"))
      if (length(day) != 1L || is.na(day)) stop("Invalid database date filter")
      paste0("convert(date, ", dataview_dbi_literal(state, format(day, "%Y%m%d")), ", 112)")
    }
    first <- day_literal(value)
    next_day <- paste0("dateadd(day, 1, ", first, ")")
    # Calendar-day filters include every time on that day. Keep the source
    # column unwrapped so ordinary date/datetime indexes remain usable.
    # datetimeoffset compares instants in SQL; filter its displayed local date.
    if (identical(state$dbi$sql_types[[position - 1L]], "datetimeoffset")) {
      column <- paste0("cast(", column, " as date)")
    }
    return(switch(type,
      equals = paste0("(", column, " >= ", first, " and ", column, " < ", next_day, ")"),
      notEqual = paste0("(", column, " < ", first, " or ", column, " >= ", next_day, ")"),
      greaterThan = paste0(column, " >= ", next_day),
      greaterThanOrEqual = paste0(column, " >= ", first),
      lessThan = paste0(column, " < ", first),
      lessThanOrEqual = paste0(column, " < ", next_day),
      inRange = paste0(
        column, " >= ", first, " and ", column,
        " < dateadd(day, 1, ", day_literal(value2), ")"
      )
    ))
  }

  if (type %in% c(
    "equals", "notEqual", "greaterThan", "greaterThanOrEqual",
    "lessThan", "lessThanOrEqual", "inRange"
  )) {
    op <- switch(type,
      equals = "=", notEqual = "<>", greaterThan = ">",
      greaterThanOrEqual = ">=", lessThan = "<", lessThanOrEqual = "<="
    )
    if (type == "inRange") {
      return(paste0(
        column, " >= ", dataview_dbi_literal(state, value),
        " and ", column, " <= ", dataview_dbi_literal(state, value2)
      ))
    }
    return(paste0(column, " ", op, " ", dataview_dbi_literal(state, value)))
  }

  text <- paste0("cast(", column, " as nvarchar(max))")
  literal <- dataview_dbi_literal(state, as.character(value %||% ""))
  switch(type,
    contains = paste0("charindex(", literal, ", ", text, ") > 0"),
    notContains = paste0("charindex(", literal, ", ", text, ") = 0"),
    startsWith = paste0("left(", text, ", len(", literal, ")) = ", literal),
    endsWith = paste0("right(", text, ", len(", literal, ")) = ", literal),
    NULL
  )
}

dataview_dbi_filter_sql <- function(state, filter_model) {
  if (is.null(filter_model) || !length(filter_model)) return("")

  filters <- character()
  for (col_id in names(filter_model)) {
    column <- dataview_dbi_identifier(state, col_id)
    if (is.null(column)) next
    model <- filter_model[[col_id]]
    position <- dataview_field_position(col_id, length(state$columns))
    conditions <- model$conditions
    if (is.null(conditions) && !is.null(model$condition1)) {
      conditions <- Filter(Negate(is.null), list(model$condition1, model$condition2))
    }
    if (is.null(conditions) || !length(conditions)) conditions <- list(model)
    parts <- Filter(Negate(is.null), lapply(
      conditions,
      function(cond) dataview_dbi_condition(state, column, cond, position)
    ))
    if (!length(parts)) next
    operator <- if (identical(toupper(model$operator %||% "AND"), "OR")) " or " else " and "
    filters <- c(filters, paste0("(", paste(parts, collapse = operator), ")"))
  }

  if (!length(filters)) "" else paste0(" where ", paste(filters, collapse = " and "))
}

dataview_dbi_order_sql <- function(state, sort_model) {
  order <- character()
  if (!is.null(sort_model) && length(sort_model)) {
    for (item in sort_model) {
      column <- dataview_dbi_identifier(state, as.character(item$colId %||% ""))
      if (is.null(column)) next
      direction <- if (identical(as.character(item$sort), "desc")) " desc" else " asc"
      order <- c(order, paste0("dataview_source.", column, direction))
    }
  }
  if (!length(order)) return(" order by (select null)")
  paste0(" order by ", paste(order, collapse = ", "))
}

dataview_dbi_projection <- function(state, positions) {
  vapply(positions, function(position) {
    column <- dataview_dbi_identifier(state, as.character(position))
    paste0("dataview_source.", column)
  }, character(1))
}

dataview_dbi_page <- function(state, start_row, end_row, sort_model, filter_model, fields = NULL) {
  positions <- dataview_page_positions(state, fields)
  projection <- paste(dataview_dbi_projection(state, positions), collapse = ", ")
  where <- dataview_dbi_filter_sql(state, filter_model)
  order <- dataview_dbi_order_sql(state, sort_model)
  from <- paste0(" from ", state$dbi$from_sql)
  query_key <- list(filter = where, sort = order, projection = positions)
  cache_state <- state$dbi_cache

  if (!identical(cache_state$filter_key, where)) {
    total <- if (!nzchar(where)) {
      state$total_rows
    } else {
      as.integer(min(as.numeric(DBI::dbGetQuery(
        state$dbi$con,
        paste0("select count_big(*) as n", from, where)
      )[[1L]][[1L]]), .Machine$integer.max))
    }
    # Publish keys only after a successful query so a failed request can retry.
    cache_state$total <- total
    cache_state$filter_key <- where
  }
  total <- cache_state$total
  row_idx <- dataview_page_indices(start_row, end_row, total)
  page <- state$dbi$schema[integer(), positions, drop = FALSE]
  if (!length(positions)) page <- data.frame(row.names = seq_along(row_idx))

  if (!identical(cache_state$query_key, query_key)) {
    cache_state$blocks <- list()
    cache_state$query_key <- query_key
  }

  if (length(row_idx) && length(positions)) {
    pages <- list()
    block_starts <- dataview_block_starts(row_idx, dataview_dbi_cache_block_size)
    for (block_start in block_starts) {
      block_end <- min(total, block_start + dataview_dbi_cache_block_size - 1L)
      key <- as.character(block_start)
      block <- cache_state$blocks[[key]]
      if (is.null(block)) {
        block <- DBI::dbGetQuery(state$dbi$con, paste0(
          "select ", projection, from, where, order,
          " offset ", format(block_start - 1L, scientific = FALSE), " rows",
          " fetch next ", block_end - block_start + 1L, " rows only"
        ))
      }
      cache_state$blocks[[key]] <- NULL
      cache_state$blocks[[key]] <- block
      if (length(cache_state$blocks) > dataview_dbi_cache_blocks) {
        cache_state$blocks <- cache_state$blocks[-1L]
      }

      selected <- row_idx[row_idx >= block_start & row_idx <= block_end]
      pages[[length(pages) + 1L]] <- block[
        selected - block_start + 1L,
        ,
        drop = FALSE
      ]
    }
    if (length(pages)) page <- do.call(rbind, pages)
  }

  for (position in seq_len(ncol(page))) {
    if (inherits(page[[position]], "POSIXt")) {
      page[[position]] <- sub(
        "\\.?0+$", "", format(page[[position]], "%Y-%m-%dT%H:%M:%OS6")
      )
    } else if (inherits(page[[position]], "Date")) {
      page[[position]] <- format(page[[position]], "%Y-%m-%d")
    } else if (inherits(page[[position]], "integer64")) {
      page[[position]] <- as.character(page[[position]])
    } else if (state$columns[[positions[[position]] + 1L]]$type == "textColumn") {
      page[[position]] <- dataview_format_column(page[[position]])
    }
  }

  page_row_idx <- if (nrow(page)) {
    seq.int(start_row + 1L, length.out = nrow(page))
  } else {
    integer()
  }
  rows <- dataview_bind_rows(page, page_row_idx, as.character(positions))
  list(rows = rows, totalRows = total, totalUnfiltered = state$total_rows, lastRow = total)
}
