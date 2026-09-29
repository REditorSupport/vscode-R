# Lazy DBI table support for the data viewer

dataview_is_dbi_lazy <- function(data) {
  inherits(data, "tbl_sql")
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

  query_sql <- as.character(dbplyr::sql_render(data))
  schema <- DBI::dbGetQuery(
    con,
    paste0("select top (0) * from (", query_sql, ") as dataview_source")
  )

  list(con = con, query_sql = query_sql, schema = schema)
}

dataview_dbi_to_state <- function(data) {
  source <- dataview_dbi_source(data)
  total_rows <- DBI::dbGetQuery(
    source$con,
    paste0("select count_big(*) as n from (", source$query_sql, ") as dataview_source")
  )[[1L]][[1L]]
  total_rows <- as.numeric(total_rows)
  if (!is.finite(total_rows) || total_rows < 0 || total_rows > .Machine$integer.max) {
    stop("database result is too large for the current data viewer row index")
  }
  total_rows <- as.integer(total_rows)

  colnames <- trimws(names(source$schema))
  headers <- c(" ", colnames)
  fields <- as.character(seq_along(headers) - 1L)
  cols <- c(
    list(integer()),
    lapply(seq_len(ncol(source$schema)), function(position) source$schema[[position]])
  )
  columns <- .mapply(get_column_def, list(headers, fields, cols), NULL)

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
    dbi_cache = new.env(parent = emptyenv()),
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

dataview_dbi_condition <- function(state, column, cond) {
  type <- as.character(cond$type %||% "")
  if (!nzchar(type)) return(NULL)
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
    conditions <- model$conditions
    if (is.null(conditions) && !is.null(model$condition1)) {
      conditions <- Filter(Negate(is.null), list(model$condition1, model$condition2))
    }
    if (is.null(conditions) || !length(conditions)) conditions <- list(model)
    parts <- Filter(Negate(is.null), lapply(
      conditions,
      function(cond) dataview_dbi_condition(state, column, cond)
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
      order <- c(order, paste0(column, direction))
    }
  }
  if (!length(order)) return(" order by (select null)")
  paste0(" order by ", paste(order, collapse = ", "))
}

dataview_dbi_page <- function(state, start_row, end_row, sort_model, filter_model) {
  where <- dataview_dbi_filter_sql(state, filter_model)
  order <- dataview_dbi_order_sql(state, sort_model)
  from <- paste0(" from (", state$dbi$query_sql, ") as dataview_source")
  filter_key <- paste0(where, collapse = "")
  query_key <- paste0(filter_key, "\n", order)

  if (!identical(state$dbi_cache$filter_key, filter_key)) {
    state$dbi_cache$filter_key <- filter_key
    state$dbi_cache$total <- if (!nzchar(where)) {
      state$total_rows
    } else {
      as.integer(min(as.numeric(DBI::dbGetQuery(
        state$dbi$con,
        paste0("select count_big(*) as n", from, where)
      )[[1L]][[1L]]), .Machine$integer.max))
    }
  }
  total <- state$dbi_cache$total

  block_size <- 1000L
  block_start <- (start_row %/% block_size) * block_size
  if (!identical(state$dbi_cache$query_key, query_key) ||
      !identical(state$dbi_cache$block_start, block_start)) {
    state$dbi_cache$query_key <- query_key
    state$dbi_cache$block_start <- block_start
    n <- max(0L, min(block_size, total - block_start))
    state$dbi_cache$page <- if (n == 0L) {
      state$dbi$schema
    } else {
      DBI::dbGetQuery(
        state$dbi$con,
        paste0(
          "select *", from, where, order,
          " offset ", block_start, " rows",
          " fetch next ", n, " rows only"
        )
      )
    }
  }

  local_start <- start_row - block_start + 1L
  local_end <- min(nrow(state$dbi_cache$page), end_row - block_start)
  page <- if (local_start <= local_end) {
    state$dbi_cache$page[local_start:local_end, , drop = FALSE]
  } else {
    state$dbi$schema
  }

  if (nrow(page)) {
    for (position in seq_len(ncol(page))) {
      if (inherits(page[[position]], "POSIXct") ||
            inherits(page[[position]], "POSIXlt")) {
        page[[position]] <- format(page[[position]], "%Y-%m-%dT%H:%M:%S")
      } else if (inherits(page[[position]], "integer64")) {
        page[[position]] <- as.character(page[[position]])
      } else if (state$columns[[position + 1L]]$type == "textColumn") {
        page[[position]] <- dataview_format_column(page[[position]])
      }
    }
  }

  row_idx <- if (nrow(page)) seq.int(start_row + 1L, length.out = nrow(page)) else integer()
  rows <- cbind(data.frame(row_idx, check.names = FALSE), page)
  names(rows) <- as.character(seq_len(ncol(rows)) - 1L)
  rownames(rows) <- NULL

  list(rows = rows, totalRows = total, totalUnfiltered = state$total_rows, lastRow = total)
}
