# Lazy Arrow support for the data viewer

dataview_is_arrow_lazy <- function(data) {
  inherits(data, "Dataset") ||
    inherits(data, "arrow_dplyr_query")
}

dataview_arrow_reader_state <- function() {
  state <- new.env(parent = emptyenv())
  state$reader <- NULL
  state$batch <- NULL
  state$batch_row <- 0L
  state$next_row <- 1L
  state$row_cache <- list()
  state
}

dataview_arrow_reader_reset <- function(state) {
  reader_state <- state$arrow_reader
  if (!is.null(reader_state$reader)) {
    try(reader_state$reader$Close(), silent = TRUE)
  }
  reader_state$reader <- dataview_arrow_reader_open(state$data)
  reader_state$batch <- NULL
  reader_state$batch_row <- 0L
  reader_state$next_row <- 1L
}

dataview_arrow_reader_open <- function(data) {
  if (inherits(data, "arrow_dplyr_query")) {
    # Scanner$create(query) does not execute ordering or aggregation nodes.
    return(getExportedValue("arrow", "as_record_batch_reader")(data))
  }
  Scanner <- getExportedValue("arrow", "Scanner")
  Scanner$create(data, batch_size = dataview_arrow_cache_block_size)$ToRecordBatchReader()
}

dataview_arrow_reader_ensure_batch <- function(reader_state) {
  if (is.null(reader_state$batch) ||
        reader_state$batch_row >= nrow(reader_state$batch)) {
    reader_state$batch <- reader_state$reader$read_next_batch()
    reader_state$batch_row <- 0L
  }
  !is.null(reader_state$batch)
}

dataview_arrow_reader_take <- function(reader_state, n, collect = TRUE) {
  pages <- list()
  while (n > 0L) {
    if (!dataview_arrow_reader_ensure_batch(reader_state)) {
      break
    }

    take <- min(n, nrow(reader_state$batch) - reader_state$batch_row)
    if (collect) {
      pages[[length(pages) + 1L]] <-
        reader_state$batch$Slice(reader_state$batch_row, take)$to_data_frame()
    }
    reader_state$batch_row <- reader_state$batch_row + take
    reader_state$next_row <- reader_state$next_row + take
    n <- n - take
  }

  if (!collect) {
    return(invisible(NULL))
  }
  if (length(pages) == 1L) {
    return(pages[[1L]])
  }
  do.call(rbind, pages)
}

dataview_arrow_reader_select <- function(reader_state, row_idx) {
  pages <- list()
  while (length(row_idx)) {
    if (row_idx[[1L]] > reader_state$next_row) {
      dataview_arrow_reader_take(
        reader_state,
        row_idx[[1L]] - reader_state$next_row,
        collect = FALSE
      )
    }
    if (!dataview_arrow_reader_ensure_batch(reader_state)) {
      break
    }

    batch_last <- reader_state$next_row +
      nrow(reader_state$batch) - reader_state$batch_row - 1L
    selected <- row_idx[row_idx <= batch_last]
    positions <- reader_state$batch_row +
      selected - reader_state$next_row + 1L
    pages[[length(pages) + 1L]] <-
      reader_state$batch[positions, , drop = FALSE]$to_data_frame()

    dataview_arrow_reader_take(
      reader_state,
      selected[[length(selected)]] - reader_state$next_row + 1L,
      collect = FALSE
    )
    row_idx <- row_idx[row_idx > batch_last]
  }

  if (length(pages) == 1L) {
    return(pages[[1L]])
  }
  do.call(rbind, pages)
}

dataview_arrow_cache_block_size <- 5000L
dataview_arrow_cache_rows <- 20000L

dataview_arrow_cache_get <- function(reader_state, row_idx) {
  if (!length(row_idx)) {
    return(NULL)
  }

  for (i in seq_along(reader_state$row_cache)) {
    cached <- reader_state$row_cache[[i]]
    if (min(row_idx) < cached$first_row || max(row_idx) > cached$last_row) {
      next
    }

    cached_idx <- match(row_idx, cached$row_idx)
    if (all(!is.na(cached_idx))) {
      reader_state$row_cache <- c(
        reader_state$row_cache[-i],
        list(cached)
      )
      return(cached$data[cached_idx, , drop = FALSE])
    }
  }
  NULL
}

dataview_arrow_cache_add <- function(reader_state, row_idx, data) {
  reader_state$row_cache[[length(reader_state$row_cache) + 1L]] <- list(
    first_row = min(row_idx),
    last_row = max(row_idx),
    row_idx = row_idx,
    data = data
  )

  while (length(reader_state$row_cache) > 1L &&
    sum(vapply(
      reader_state$row_cache,
      function(cached) length(cached$row_idx),
      integer(1)
    )) > dataview_arrow_cache_rows) {
    reader_state$row_cache <- reader_state$row_cache[-1L]
  }
}

dataview_arrow_cached_slice <- function(state, row_idx) {
  if (!length(row_idx)) {
    return(dataview_schema(state$data))
  }

  reader_state <- state$arrow_reader
  missing <- rep(TRUE, length(row_idx))
  pages <- list()
  positions <- list()
  touched <- integer()

  for (i in rev(seq_along(reader_state$row_cache))) {
    cached <- reader_state$row_cache[[i]]
    remaining <- which(missing)
    cached_idx <- match(row_idx[remaining], cached$row_idx)
    matched <- !is.na(cached_idx)
    if (!any(matched)) {
      next
    }

    pages[[length(pages) + 1L]] <-
      cached$data[cached_idx[matched], , drop = FALSE]
    positions[[length(positions) + 1L]] <- remaining[matched]
    missing[remaining[matched]] <- FALSE
    touched <- c(i, touched)
    if (!any(missing)) break
  }
  if (length(touched)) {
    reader_state$row_cache <- c(
      reader_state$row_cache[-touched], reader_state$row_cache[touched]
    )
  }

  if (any(missing)) {
    missing_idx <- row_idx[missing]
    page <- dataview_arrow_slice(state, missing_idx)
    pages[[length(pages) + 1L]] <- page
    positions[[length(positions) + 1L]] <- which(missing)
  }

  if (length(pages) == 1L) {
    return(pages[[1L]])
  }

  page <- do.call(rbind, pages)
  page[order(unlist(positions)), , drop = FALSE]
}

dataview_arrow_block_slice <- function(state, row_idx) {
  reader_state <- state$arrow_reader
  pages <- list()
  block_starts <- unique(
    (row_idx - 1L) %/% dataview_arrow_cache_block_size *
      dataview_arrow_cache_block_size + 1L
  )

  for (block_start in block_starts) {
    block_end <- min(
      state$total_rows,
      block_start + dataview_arrow_cache_block_size - 1L
    )
    block_row_idx <- seq.int(block_start, block_end)
    cached <- dataview_arrow_cache_get(reader_state, block_row_idx)

    if (is.null(cached)) {
      if (block_start < reader_state$next_row) {
        # A backward miss must not rewind the reader used for forward scrolling.
        cached <- dataview_slice(state$data, block_row_idx)
      } else {
        if (is.null(reader_state$reader)) {
          dataview_arrow_reader_reset(state)
        }
        if (block_start > reader_state$next_row) {
          dataview_arrow_reader_take(
            reader_state,
            block_start - reader_state$next_row,
            collect = FALSE
          )
        }
        cached <- dataview_arrow_reader_take(
          reader_state,
          block_end - block_start + 1L
        )
      }
      dataview_arrow_cache_add(reader_state, block_row_idx, cached)
    }

    selected <- row_idx[row_idx >= block_start & row_idx <= block_end]
    pages[[length(pages) + 1L]] <- cached[
      selected - block_start + 1L,
      ,
      drop = FALSE
    ]
  }

  if (length(pages) == 1L) {
    return(pages[[1L]])
  }
  do.call(rbind, pages)
}

dataview_arrow_slice <- function(state, row_idx) {
  if (!length(row_idx)) {
    return(dataview_schema(state$data))
  }
  if (length(row_idx) > 1L && any(diff(row_idx) <= 0L)) {
    page <- dataview_slice(state$data, row_idx)
    dataview_arrow_cache_add(state$arrow_reader, row_idx, page)
    return(page)
  }

  first_row <- row_idx[[1L]]
  reader_state <- state$arrow_reader

  if (length(row_idx) == 1L || all(diff(row_idx) == 1L)) {
    return(dataview_arrow_block_slice(state, row_idx))
  }

  cached <- dataview_arrow_cache_get(reader_state, row_idx)
  if (!is.null(cached)) {
    return(cached)
  }

  if (first_row < reader_state$next_row) {
    page <- dataview_slice(state$data, row_idx)
    dataview_arrow_cache_add(reader_state, row_idx, page)
    return(page)
  }
  if (is.null(reader_state$reader)) {
    dataview_arrow_reader_reset(state)
  }
  if (first_row > reader_state$next_row) {
    dataview_arrow_reader_take(
      reader_state,
      first_row - reader_state$next_row,
      collect = FALSE
    )
  }

  page <- dataview_arrow_reader_select(reader_state, row_idx)
  dataview_arrow_cache_add(reader_state, row_idx, page)
  page
}

dataview_arrow_query_slice <- function(state, display_idx) {
  if (!length(display_idx)) {
    return(dataview_schema(state$data))
  }

  # Cache by source row, so sorted and filtered views share the same bounded
  # cache and can reuse rows across model changes and backward scrolling.
  block_starts <- unique(
    (display_idx - 1L) %/% dataview_arrow_cache_block_size *
      dataview_arrow_cache_block_size + 1L
  )
  pages <- lapply(block_starts, function(block_start) {
    block_end <- min(
      length(state$query_indices), block_start + dataview_arrow_cache_block_size - 1L
    )
    block_display_idx <- seq.int(block_start, block_end)
    page <- dataview_arrow_cached_slice(
      state, state$query_indices[block_display_idx]
    )
    selected <- display_idx[display_idx >= block_start & display_idx <= block_end]
    page[selected - block_start + 1L, , drop = FALSE]
  })
  if (length(pages) == 1L) return(pages[[1L]])
  do.call(rbind, pages)
}
