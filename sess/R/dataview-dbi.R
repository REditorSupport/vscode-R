dataview_is_dbi_lazy <- function(data) {
  inherits(data, "tbl_sql")
}

dataview_dbi_cache_block_size <- 5000L
dataview_dbi_cache_rows <- 20000L

dataview_dbi_source <- function(data) {
  if (!requireNamespace("DBI", quietly = TRUE) ||
        !requireNamespace("dbplyr", quietly = TRUE)) {
    stop("Viewing lazy database tables requires the optional 'DBI' and 'dbplyr' packages")
  }
  con <- dbplyr::remote_con(data)
  if (!inherits(con, "DBIConnection") || !DBI::dbIsValid(con)) {
    stop("the lazy table does not have a valid DBI connection")
  }
  # Let dbplyr translate metadata SQL for the connection's dialect. Execute the
  # original top-level query when fetching rows, preserving its own operations.
  source_sql <- suppressWarnings(dbplyr::sql_render(data, subquery = TRUE))
  schema <- DBI::dbGetQuery(con, as.character(dbplyr::sql_query_fields(con, source_sql)))
  list(con = con, query_sql = as.character(dbplyr::sql_render(data)), schema = schema)
}

dataview_dbi_to_state <- function(data) {
  source <- dataview_dbi_source(data)
  colnames <- names(source$schema)
  headers <- c(" ", trimws(colnames))
  fields <- as.character(seq_along(headers) - 1L)
  cols <- c(list(integer()), as.list(source$schema))
  columns <- .mapply(get_column_def, list(headers, fields, cols), NULL)
  columns <- lapply(columns, function(column) {
    column$filter <- jsonlite::unbox(FALSE)
    column$sortable <- jsonlite::unbox(FALSE)
    column
  })
  list(
    dbi = source,
    columns = columns,
    column_names = colnames,
    total_rows = NULL,
    uses_result_cache = TRUE,
    dbi_cache = dataview_dbi_cache_state()
  )
}

dataview_dbi_cache_state <- function() {
  state <- new.env(parent = emptyenv())
  state$result <- NULL
  state$result_cache_dir <- NULL
  state$result_cache_blocks <- list()
  state$result_cache_rows <- 0L
  state$result_complete <- FALSE
  state
}

dataview_dbi_result_reset <- function(cache_state, clear_cache = FALSE) {
  if (!is.null(cache_state$result)) {
    try(DBI::dbClearResult(cache_state$result), silent = TRUE)
  }
  cache_state$result <- NULL
  if (clear_cache) {
    # A new execution must never append to rows from the failed cursor.
    for (block in cache_state$result_cache_blocks) {
      if (!is.null(block$path)) unlink(block$path, force = TRUE)
    }
    cache_state$result_cache_blocks <- list()
    cache_state$result_cache_rows <- 0L
    cache_state$result_complete <- FALSE
  }
}

dataview_dbi_result_cache_init <- function(state, view_id) {
  if (!isTRUE(state$uses_result_cache)) return(invisible(NULL))
  if (!requireNamespace("arrow", quietly = TRUE)) {
    stop("Viewing lazy database tables requires the optional 'arrow' package")
  }

  root <- file.path(tempdir(), "vscode-r-dataview")
  dir.create(root, recursive = TRUE, showWarnings = FALSE)
  result_cache_dir <- tempfile(
    pattern = paste0(view_id, "-dbi-"), tmpdir = root
  )
  if (!dir.create(result_cache_dir, showWarnings = FALSE)) {
    stop("unable to create temporary database data viewer cache")
  }

  state$dbi_cache$result_cache_dir <- result_cache_dir
  state$dbi_cache$result_cache_blocks <- list()
  state$dbi_cache$result_cache_rows <- 0L
  state$dbi_cache$result_complete <- FALSE
  invisible(NULL)
}

dataview_dbi_result_cache_cleanup <- function(state) {
  if (is.null(state$dbi_cache)) return(invisible(NULL))

  dataview_dbi_result_reset(state$dbi_cache)
  result_cache_dir <- state$dbi_cache$result_cache_dir
  if (!is.null(result_cache_dir) && dir.exists(result_cache_dir)) {
    unlink(result_cache_dir, recursive = TRUE, force = TRUE)
  }
  state$dbi_cache$result_cache_dir <- NULL
  state$dbi_cache$result_cache_blocks <- list()
  state$dbi_cache$result_cache_rows <- 0L
  state$dbi_cache$result_complete <- FALSE
  invisible(NULL)
}

dataview_dbi_result_cache_add <- function(cache_state, block) {
  if (!nrow(block)) return(invisible(NULL))

  block_number <- length(cache_state$result_cache_blocks) + 1L
  first_row <- cache_state$result_cache_rows + 1L
  last_row <- first_row + nrow(block) - 1L
  cache_state$result_cache_blocks[[block_number]] <- list(
    data = block,
    path = NULL,
    first_row = first_row,
    last_row = last_row
  )
  cache_state$result_cache_rows <- last_row

  in_memory_rows <- function() {
    sum(vapply(
      cache_state$result_cache_blocks,
      function(cached) {
        if (is.null(cached$data)) 0L else cached$last_row - cached$first_row + 1L
      },
      integer(1)
    ))
  }

  while (length(cache_state$result_cache_blocks) > 1L &&
           in_memory_rows() > dataview_dbi_cache_rows) {
    position <- which(vapply(
      cache_state$result_cache_blocks,
      function(cached) !is.null(cached$data),
      logical(1)
    ))[[1L]]
    cached <- cache_state$result_cache_blocks[[position]]
    path <- file.path(
      cache_state$result_cache_dir,
      sprintf("block-%08d.arrow", position)
    )
    temporary_path <- paste0(path, ".tmp")
    on.exit(unlink(temporary_path, force = TRUE), add = TRUE)
    getExportedValue("arrow", "write_ipc_file")(
      getExportedValue("arrow", "Table")$create(cached$data),
      temporary_path
    )
    if (!file.rename(temporary_path, path)) {
      stop("unable to finalize temporary database data viewer cache")
    }
    cached$data <- NULL
    cached$path <- path
    cache_state$result_cache_blocks[[position]] <- cached
  }
  invisible(NULL)
}

dataview_dbi_result_cache_slice <- function(state, row_idx, positions) {
  cache_state <- state$dbi_cache
  target <- if (length(row_idx)) max(row_idx) else 0L

  if (target > cache_state$result_cache_rows &&
        !isTRUE(cache_state$result_complete)) {
    if (is.null(cache_state$result)) {
      cache_state$result <- DBI::dbSendQuery(
        state$dbi$con, state$dbi$query_sql
      )
    }

    while (target > cache_state$result_cache_rows &&
             !isTRUE(cache_state$result_complete)) {
      block <- tryCatch(
        DBI::dbFetch(cache_state$result, n = dataview_dbi_cache_block_size),
        error = function(e) {
          dataview_dbi_result_reset(cache_state, clear_cache = TRUE)
          stop(e)
        },
        interrupt = function(e) {
          dataview_dbi_result_reset(cache_state, clear_cache = TRUE)
          stop(e)
        }
      )
      dataview_dbi_result_cache_add(cache_state, block)
      if (!nrow(block) || DBI::dbHasCompleted(cache_state$result)) {
        cache_state$result_complete <- TRUE
        dataview_dbi_result_reset(cache_state)
      }
    }
  }

  available <- row_idx[row_idx <= cache_state$result_cache_rows]
  if (!length(available)) {
    return(state$dbi$schema[integer(), positions, drop = FALSE])
  }

  pages <- list()
  page_rows <- integer()
  for (cached in cache_state$result_cache_blocks) {
    selected <- available[
      available >= cached$first_row & available <= cached$last_row
    ]
    if (!length(selected)) next

    rows <- selected - cached$first_row + 1L
    page <- if (!length(positions)) {
      data.frame(row.names = seq_along(selected))
    } else if (!is.null(cached$data)) {
      cached$data[rows, positions, drop = FALSE]
    } else {
      data <- getExportedValue("arrow", "read_ipc_file")(
        cached$path,
        col_select = state$column_names[positions],
        as_data_frame = FALSE
      )
      dataview_arrow_data_frame(data$Take(rows - 1L))
    }
    pages[[length(pages) + 1L]] <- page
    page_rows <- c(page_rows, selected)
  }

  page <- if (length(pages) == 1L) pages[[1L]] else do.call(rbind, pages)
  page[match(available, page_rows), , drop = FALSE]
}

dataview_dbi_page <- function(
  state, start_row, end_row, sort_model, filter_model, fields = NULL
) {
  positions <- dataview_page_positions(state, fields)
  # Ignore stale viewer controls: database results are fetched in source order.
  total <- if (isTRUE(state$dbi_cache$result_complete)) state$dbi_cache$result_cache_rows else NULL
  row_idx <- if (is.null(total)) {
    if (start_row < end_row) seq.int(start_row + 1L, end_row) else integer()
  } else {
    dataview_page_indices(start_row, end_row, total)
  }
  page <- dataview_dbi_result_cache_slice(state, row_idx, positions)

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

  page_row_idx <- row_idx[seq_len(nrow(page))]
  rows <- dataview_bind_rows(page, page_row_idx, as.character(positions))
  c(list(rows = rows), dataview_lazy_totals(state))
}
