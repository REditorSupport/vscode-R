# Viewer operations over one cached execution of a transformed lazy query.

dataview_query_positions <- function(state, sort_model, filter_model) {
  positions <- integer()
  for (field in names(filter_model)) {
    pos <- dataview_field_position(field, length(state$columns))
    if (!is.na(pos) && pos > 1L && !isFALSE(state$columns[[pos]]$filter)) {
      positions <- c(positions, pos)
    }
  }
  for (item in sort_model) {
    pos <- dataview_field_position(as.character(item$colId %||% ""), length(state$columns))
    if (!is.na(pos) && pos > 1L && !isFALSE(state$columns[[pos]]$sortable)) {
      positions <- c(positions, pos)
    }
  }
  unique(positions)
}

dataview_lazy_cache <- function(state) {
  state$dbi_cache
}

dataview_lazy_cache_slice <- function(state, rows, positions) {
  dataview_dbi_result_cache_slice(state, rows, positions)
}

dataview_lazy_page_indices <- function(state, start_row, end_row, sort_model, filter_model) {
  cache <- dataview_lazy_cache(state)
  key <- dataview_query_key(sort_model, filter_model)
  if (!identical(key, cache$result_query_key)) {
    # Keep key columns in source order across in-memory and IPC projections.
    positions <- sort(dataview_query_positions(state, sort_model, filter_model))
    indices <- NULL
    if (length(positions)) {
      # Finish the existing execution, spilling batches as usual. An infinite
      # target drains the reader without assembling the full result in R.
      dataview_lazy_cache_slice(state, Inf, integer())
      if (cache$result_cache_rows > .Machine$integer.max) {
        stop("query result is too large for the current data viewer row index")
      }
      indices <- integer()
      if (cache$result_cache_rows > 0L) {
        query_state <- state
        query_state$total_rows <- cache$result_cache_rows
        columns <- dataview_lazy_cache_slice(
          state, seq_len(cache$result_cache_rows), positions - 1L
        )
        query_state$query_columns <- setNames(as.list(columns), as.character(positions))
        indices <- dataview_apply_filter_model(query_state, filter_model, NULL)
        indices <- dataview_apply_sort_model(query_state, sort_model, indices)
      }
    }
    # Publish only after success. A cancelled/failed operation can be retried,
    # and changing controls always starts from the original cached result.
    cache$result_query_indices <- indices
    cache$result_query_key <- key
  }

  total <- dataview_lazy_totals(state)$totalRows
  display_idx <- if (is.null(total)) {
    if (start_row < end_row) seq.int(start_row + 1L, end_row) else integer()
  } else {
    dataview_page_indices(start_row, end_row, total)
  }
  if (is.null(cache$result_query_indices)) display_idx else cache$result_query_indices[display_idx]
}

dataview_lazy_totals <- function(state) {
  cache <- dataview_lazy_cache(state)
  original_total <- if (isTRUE(cache$result_complete)) cache$result_cache_rows else state$total_rows
  total <- if (is.null(cache$result_query_indices)) {
    original_total
  } else {
    length(cache$result_query_indices)
  }
  c(
    list(lastRow = total %||% -1L),
    if (!is.null(total)) list(totalRows = total, totalUnfiltered = original_total)
  )
}
