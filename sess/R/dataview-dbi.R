dataview_is_dbi_lazy <- function(data) {
  inherits(data, "tbl_sql")
}

dataview_dbi_cache_block_size <- 1000L
dataview_dbi_sort_block_size <- 5000L
dataview_dbi_cache_rows <- 20000L


dataview_dbi_require <- function() {
  if (!requireNamespace("DBI", quietly = TRUE) ||
        !requireNamespace("dbplyr", quietly = TRUE)) {
    stop("Viewing lazy database tables requires the optional 'DBI' and 'dbplyr' packages")
  }
}

dataview_dbi_source <- function(data) {
  dataview_dbi_require()
  con <- data$src$con
  if (!inherits(con, "DBIConnection") || !DBI::dbIsValid(con)) {
    stop("the lazy table does not have a valid DBI connection")
  }
  # Extension point for other database backends / SQL dialects: start
  # Add backend recognition here before using backend-specific SQL below.
  if (!inherits(con, "Microsoft SQL Server") &&
        !grepl("SQL Server", DBI::dbGetInfo(con)$dbms.name %||% "", fixed = TRUE)) {
    stop("Lazy database viewing currently supports SQL Server connections")
  }
  # Extension point for other database backends / SQL dialects: end

  # Keep the source ordering for the outer Data Viewer query, not inside the subquery.
  order <- dbplyr::op_sort(data)
  source_sql <- suppressWarnings(dbplyr::sql_render(data, subquery = TRUE))
  from_sql <- as.character(
    dbplyr::sql_query_wrap(con, source_sql, name = "dataview_source")
  )
  # Extension point for other database backends / SQL dialects: start
  # Schema probing currently uses SQL Server TOP.
  schema <- DBI::dbGetQuery(
    con,
    paste0("select top (0) * from ", from_sql)
  )
  # Extension point for other database backends / SQL dialects: end
  source_order <- if (length(order)) {
    as.character(dbplyr::translate_sql_(
      order,
      con = con,
      window = FALSE,
      context = list(clause = "ORDER")
    ))
  } else {
    character()
  }
  source_order_columns <- vapply(order, function(expr) {
    if (is.symbol(expr)) {
      as.character(expr)
    } else if (is.call(expr) &&
                 identical(expr[[1L]], as.name("desc")) &&
                 is.symbol(expr[[2L]])) {
      as.character(expr[[2L]])
    } else {
      NA_character_
    }
  }, character(1))
  list(
    con = con,
    from_sql = from_sql,
    page_from_sql = from_sql,
    source_order = source_order,
    source_order_columns = source_order_columns,
    schema = schema
  )
}

dataview_dbi_to_state <- function(data) {
  source <- dataview_dbi_source(data)
  # Extension point for other database backends / SQL dialects: start
  # Row counting currently uses SQL Server COUNT_BIG.
  total_rows <- DBI::dbGetQuery(
    source$con,
    paste0("select count_big(*) as n from ", source$from_sql)
  )[[1L]][[1L]]
  # Extension point for other database backends / SQL dialects: end
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

  list(
    dbi = source,
    columns = columns,
    column_names = colnames,
    total_rows = total_rows,
    dbi_cache = dataview_dbi_cache_state()
  )
}

dataview_dbi_cache_state <- function() {
  state <- new.env(parent = emptyenv())
  state$filter_key <- NULL
  state$total <- NULL
  state$query_key <- NULL
  state$blocks <- list()
  state$result <- NULL
  state$next_row <- NULL
  state
}

dataview_dbi_result_reset <- function(cache_state) {
  if (!is.null(cache_state$result)) {
    try(DBI::dbClearResult(cache_state$result), silent = TRUE)
  }
  cache_state$result <- NULL
  cache_state$next_row <- NULL
}

dataview_dbi_cache_get <- function(cache_state, block_start) {
  key <- as.character(block_start)
  block <- cache_state$blocks[[key]]
  if (is.null(block)) return(NULL)
  cache_state$blocks[[key]] <- NULL
  cache_state$blocks[[key]] <- block
  block
}

dataview_dbi_cache_add <- function(cache_state, block_start, block) {
  key <- as.character(block_start)
  cache_state$blocks[[key]] <- NULL
  cache_state$blocks[[key]] <- block
  while (length(cache_state$blocks) > 1L &&
           sum(vapply(cache_state$blocks, nrow, integer(1))) > dataview_dbi_cache_rows) {
    cache_state$blocks <- cache_state$blocks[-1L]
  }
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
  # Extension point for other database backends / SQL dialects: start
  # Date/datetime/text filters below currently use SQL Server SQL.
  type <- as.character(cond$type %||% "")
  if (!nzchar(type)) return(NULL)
  column_type <- as.character(state$columns[[position]]$type)
  is_date <- identical(column_type, "dateColumn")
  is_datetime <- identical(column_type, "datetimeColumn")
  is_text <- identical(column_type, "textColumn")

  if ((is_date || is_datetime) && type %in% c("blank", "notBlank")) {
    return(paste0(column, if (type == "blank") " is null" else " is not null"))
  }
  if (type %in% c("blank", "notBlank")) {
    text <- paste0("ltrim(rtrim(cast(", column, " as nvarchar(max))))")
    if (type == "blank") {
      return(paste0("(", column, " is null or ", text, " = '')"))
    }
    return(paste0("(", column, " is not null and ", text, " <> '')"))
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
    second <- if (type == "inRange") day_literal(value2) else NULL
    return(switch(type,
      equals = paste0(column, " = ", first),
      notEqual = paste0(column, " <> ", first),
      greaterThan = paste0(column, " > ", first),
      greaterThanOrEqual = paste0(column, " >= ", first),
      lessThan = paste0(column, " < ", first),
      lessThanOrEqual = paste0(column, " <= ", first),
      inRange = paste0(column, " >= ", first, " and ", column, " <= ", second)
    ))
  }

  if (is_datetime && type %in% c(
    "equals", "notEqual", "greaterThan", "greaterThanOrEqual",
    "lessThan", "lessThanOrEqual", "inRange"
  )) {
    datetime_literal <- function(value) {
      datetime <- suppressWarnings(as.POSIXct(as.character(value)))
      if (length(datetime) != 1L || is.na(datetime)) stop("Invalid database date filter")
      paste0(
        "convert(datetime2, ",
        dataview_dbi_literal(
          state,
          sub("\\.?0+$", "", format(datetime, "%Y-%m-%dT%H:%M:%OS6"))
        ),
        ", 126)"
      )
    }
    first <- datetime_literal(value)
    second <- if (type == "inRange") datetime_literal(value2) else NULL
    return(switch(type,
      equals = paste0(column, " = ", first),
      notEqual = paste0(column, " <> ", first),
      greaterThan = paste0(column, " > ", first),
      greaterThanOrEqual = paste0(column, " >= ", first),
      lessThan = paste0(column, " < ", first),
      lessThanOrEqual = paste0(column, " <= ", first),
      inRange = paste0(column, " >= ", first, " and ", column, " <= ", second)
    ))
  }

  if (is_text) {
    text <- paste0("lower(cast(", column, " as nvarchar(max)))")
    literal <- dataview_dbi_literal(state, tolower(as.character(value %||% "")))
    return(switch(type,
      equals = paste0(text, " = ", literal),
      notEqual = paste0(text, " <> ", literal),
      contains = paste0("charindex(", literal, ", ", text, ") > 0"),
      notContains = paste0("charindex(", literal, ", ", text, ") = 0"),
      startsWith = paste0("left(", text, ", len(", literal, ")) = ", literal),
      endsWith = paste0("right(", text, ", len(", literal, ")) = ", literal),
      NULL
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

  NULL
  # Extension point for other database backends / SQL dialects: end
}

dataview_dbi_filter_sql <- function(state, filter_model) {
  if (is.null(filter_model) || !length(filter_model)) return("")

  filters <- character()
  for (col_id in names(filter_model)) {
    column <- dataview_dbi_identifier(state, col_id)
    if (is.null(column)) next
    model <- filter_model[[col_id]]
    position <- dataview_field_position(col_id, length(state$columns))
    if (is.na(position) || isFALSE(state$columns[[position]]$filter)) next
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
  # Extension point for other database backends / SQL dialects: start
  # Default and NULL ordering may vary by backend.
  order <- character()
  viewer_columns <- character()
  if (!is.null(sort_model) && length(sort_model)) {
    for (item in sort_model) {
      col_id <- as.character(item$colId %||% "")
      position <- dataview_field_position(col_id, length(state$columns))
      if (is.na(position) || isFALSE(state$columns[[position]]$sortable)) next
      column <- dataview_dbi_identifier(state, col_id)
      if (is.null(column)) next
      viewer_columns <- c(viewer_columns, state$column_names[[position - 1L]])
      column <- paste0("dataview_source.", column)
      direction <- if (identical(as.character(item$sort), "desc")) " desc" else " asc"
      order <- c(
        order,
        paste0("case when ", column, " is null then 1 else 0 end"),
        paste0(column, direction)
      )
    }
  }
  keep <- is.na(state$dbi$source_order_columns) |
    !(state$dbi$source_order_columns %in% viewer_columns)
  order <- c(order, state$dbi$source_order[keep])
  if (!length(order)) return(" order by (select null)")
  result <- paste0(" order by ", paste(order, collapse = ", "))
  # Extension point for other database backends / SQL dialects: end
  result
}

dataview_dbi_page <- function(state, start_row, end_row, sort_model, filter_model, fields = NULL) {
  positions <- dataview_page_positions(state, fields)
  projection <- paste(vapply(positions, function(position) {
    column <- dataview_dbi_identifier(state, as.character(position))
    paste0("dataview_source.", column)
  }, character(1)), collapse = ", ")
  where <- dataview_dbi_filter_sql(state, filter_model)
  order <- dataview_dbi_order_sql(state, sort_model)
  count_from <- paste0(" from ", state$dbi$from_sql)
  page_from <- paste0(" from ", state$dbi$page_from_sql)
  query_key <- list(filter = where, sort = order, projection = positions)
  cache_state <- state$dbi_cache

  if (!identical(cache_state$query_key, query_key)) {
    dataview_dbi_result_reset(cache_state)
    cache_state$blocks <- list()
    cache_state$query_key <- query_key
  }

  if (!identical(cache_state$filter_key, where)) {
    total <- if (!nzchar(where)) {
      state$total_rows
    } else {
      as.integer(min(as.numeric(DBI::dbGetQuery(
        state$dbi$con,
        paste0("select count_big(*) as n", count_from, where)
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

  if (length(row_idx) && length(positions)) {
    pages <- list()
    block_size <- if (!is.null(sort_model) && length(sort_model)) {
      dataview_dbi_sort_block_size
    } else {
      dataview_dbi_cache_block_size
    }
    block_starts <- dataview_block_starts(row_idx, block_size)
    for (block_start in block_starts) {
      block_end <- min(total, block_start + block_size - 1L)
      block <- dataview_dbi_cache_get(cache_state, block_start)
      if (is.null(block)) {
        if (is.null(cache_state$result) || cache_state$next_row != block_start) {
          dataview_dbi_result_reset(cache_state)
          # Extension point for other database backends / SQL dialects: start
          # SQL Server OFFSET positions a new cursor for non-sequential requests.
          cache_state$result <- DBI::dbSendQuery(state$dbi$con, paste0(
            "select ", projection, page_from, where, order,
            " offset ", format(block_start - 1L, scientific = FALSE), " rows"
          ))
          # Extension point for other database backends / SQL dialects: end
          cache_state$next_row <- block_start
        }
        block <- tryCatch(
          DBI::dbFetch(cache_state$result, n = block_end - block_start + 1L),
          error = function(e) {
            dataview_dbi_result_reset(cache_state)
            stop(e)
          },
          interrupt = function(e) {
            dataview_dbi_result_reset(cache_state)
            stop(e)
          }
        )
        cache_state$next_row <- block_start + nrow(block)
        dataview_dbi_cache_add(cache_state, block_start, block)
        if (cache_state$next_row > total) {
          dataview_dbi_result_reset(cache_state)
        }
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
