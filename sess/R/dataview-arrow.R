# Lazy Arrow support for the data viewer

dataview_is_arrow_lazy <- function(data) {
  inherits(data, "Dataset") ||
    inherits(data, "arrow_dplyr_query")
}

dataview_arrow_nested_columns <- function(data) {
  schema <- getExportedValue("arrow", "infer_schema")(data)
  vapply(schema$fields, function(field) {
    inherits(
      field$type,
      c("ListType", "LargeListType", "FixedSizeListType", "MapType", "StructType")
    )
  }, logical(1))
}

dataview_arrow_data_frame <- function(data) {
  old_options <- options(arrow.int64_downcast = FALSE)
  on.exit(options(old_options), add = TRUE)

  page <- as.data.frame(data, optional = TRUE)
  schema <- tryCatch(
    getExportedValue("arrow", "infer_schema")(data),
    error = function(e) NULL
  )
  if (!is.null(schema) && inherits(data, "ArrowTabular")) {
    for (position in seq_len(ncol(page))) {
      type <- schema$fields[[position]]$type
      if (inherits(
        type,
        c("Int64Type", "Date32Type", "Date64Type", "TimestampType", "DurationType")
      )) {
        values <- tryCatch(
          as.vector(data[[position]]),
          error = function(e) NULL
        )
        if (!is.null(values) && length(values) == nrow(page)) {
          page[[position]] <- values
        }
      }
    }
  }
  for (position in seq_len(ncol(page))) {
    if (inherits(page[[position]], "vctrs_list_of")) {
      page[[position]] <- as.list(page[[position]])
    }
  }
  page
}

dataview_arrow_bind_column <- function(values) {
  template <- values[[1L]]
  if (inherits(template, "integer64")) {
    value <- unlist(lapply(values, unclass), use.names = FALSE)
    class(value) <- "integer64"
    return(value)
  }
  if (inherits(template, "Date")) {
    return(structure(
      unlist(lapply(values, unclass), use.names = FALSE),
      class = "Date"
    ))
  }
  if (inherits(template, "POSIXct")) {
    value <- structure(
      unlist(lapply(values, unclass), use.names = FALSE),
      class = class(template)
    )
    attr(value, "tzone") <- attr(template, "tzone", exact = TRUE)
    return(value)
  }
  if (inherits(template, "difftime")) {
    return(as.difftime(
      unlist(lapply(values, unclass), use.names = FALSE),
      units = attr(template, "units", exact = TRUE)
    ))
  }
  do.call(c, values)
}

dataview_arrow_bind_pages <- function(pages) {
  if (length(pages) == 1L) {
    return(pages[[1L]])
  }

  columns <- lapply(seq_len(ncol(pages[[1L]])), function(position) {
    dataview_arrow_bind_column(lapply(pages, function(page) page[[position]]))
  })
  names(columns) <- names(pages[[1L]])
  n <- sum(vapply(pages, nrow, integer(1)))
  structure(
    columns,
    class = "data.frame",
    row.names = c(NA_integer_, -n)
  )
}

dataview_arrow_reader_state <- function() {
  state <- new.env(parent = emptyenv())
  state$reader <- NULL
  state$batch <- NULL
  state$batch_row <- 0L
  state$next_row <- 1L
  state$row_cache <- list()
  state$query_cache <- list()
  state$fragment_index <- NULL
  state
}

dataview_arrow_reader_reset <- function(state) {
  reader_state <- state$arrow_reader
  if (!is.null(reader_state$reader)) {
    try(reader_state$reader$Close(), silent = TRUE)
  }
  reader_state$reader <- NULL
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
  Scanner$create(data, batch_size = dataview_arrow_reader_batch_size)$ToRecordBatchReader()
}

dataview_arrow_column <- function(data, position) {
  old_options <- options(arrow.int64_downcast = FALSE)
  on.exit(options(old_options), add = TRUE)

  name <- names(data)[[position]]
  Scanner <- getExportedValue("arrow", "Scanner")
  reader <- Scanner$create(
    data,
    projection = name,
    batch_size = dataview_arrow_reader_batch_size
  )$ToRecordBatchReader()
  on.exit(try(reader$Close(), silent = TRUE), add = TRUE)
  dataview_arrow_data_frame(reader$read_table())[[name]]
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
        dataview_arrow_data_frame(
          reader_state$batch$Slice(reader_state$batch_row, take)
        )
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
  dataview_arrow_bind_pages(pages)
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
      dataview_arrow_data_frame(
        reader_state$batch[positions, , drop = FALSE]
      )

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
  dataview_arrow_bind_pages(pages)
}

dataview_arrow_reader_batch_size <- 5000L
dataview_arrow_cache_block_size <- 1000L
dataview_arrow_query_block_size <- 5000L
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

dataview_arrow_query_cache_get <- function(reader_state, query_key, block_start) {
  for (i in rev(seq_along(reader_state$query_cache))) {
    cached <- reader_state$query_cache[[i]]
    if (!identical(cached$query_key, query_key) ||
        cached$block_start != block_start) {
      next
    }
    reader_state$query_cache <- c(
      reader_state$query_cache[-i],
      list(cached)
    )
    return(cached$data)
  }
  NULL
}

dataview_arrow_query_cache_add <- function(
  reader_state,
  query_key,
  block_start,
  data
) {
  reader_state$query_cache[[length(reader_state$query_cache) + 1L]] <- list(
    query_key = query_key,
    block_start = block_start,
    data = data
  )
  while (length(reader_state$query_cache) > 1L &&
    sum(vapply(
      reader_state$query_cache,
      function(cached) nrow(cached$data),
      integer(1)
    )) > dataview_arrow_cache_rows) {
    reader_state$query_cache <- reader_state$query_cache[-1L]
  }
}

dataview_arrow_fragment_index <- function(state) {
  reader_state <- state$arrow_reader
  if (isFALSE(reader_state$fragment_index)) {
    return(NULL)
  }
  if (!is.null(reader_state$fragment_index)) {
    return(reader_state$fragment_index)
  }

  data <- state$data
  if (!inherits(data, "FileSystemDataset") || length(data$files) < 2L) {
    reader_state$fragment_index <- FALSE
    return(NULL)
  }

  FileSystemDatasetFactory <- getExportedValue(
    "arrow", "FileSystemDatasetFactory"
  )
  fragments <- lapply(data$files, function(path) {
    tryCatch(
      FileSystemDatasetFactory$create(
        data$filesystem,
        paths = path,
        format = data$format
      )$Finish(schema = data$schema),
      error = function(e) NULL
    )
  })
  if (any(vapply(fragments, is.null, logical(1)))) {
    reader_state$fragment_index <- FALSE
    return(NULL)
  }

  counts <- vapply(
    fragments,
    function(fragment) as.numeric(fragment$num_rows),
    numeric(1)
  )
  if (any(!is.finite(counts)) || sum(counts) != state$total_rows) {
    reader_state$fragment_index <- FALSE
    return(NULL)
  }

  keep <- counts > 0
  fragments <- fragments[keep]
  counts <- counts[keep]
  ends <- cumsum(counts)
  starts <- c(1, head(ends, -1L) + 1)

  reader_state$fragment_index <- list(
    datasets = fragments,
    starts = starts,
    ends = ends
  )
  reader_state$fragment_index
}

dataview_arrow_fragment_slice <- function(state, row_idx) {
  index <- dataview_arrow_fragment_index(state)
  if (is.null(index) || !length(row_idx)) {
    return(NULL)
  }

  fragment_pos <- findInterval(row_idx - 1, index$ends) + 1L
  if (any(fragment_pos < 1L | fragment_pos > length(index$datasets))) {
    return(NULL)
  }

  pages <- list()
  positions <- list()
  for (fragment in unique(fragment_pos)) {
    position <- which(fragment_pos == fragment)
    local_idx <- row_idx[position] - index$starts[[fragment]] + 1
    pages[[length(pages) + 1L]] <- dataview_slice(
      index$datasets[[fragment]], local_idx
    )
    positions[[length(positions) + 1L]] <- position
  }

  if (length(pages) == 1L) {
    return(pages[[1L]])
  }
  page <- dataview_arrow_bind_pages(pages)
  page[order(unlist(positions)), , drop = FALSE]
}

dataview_arrow_query_forward_slice <- function(state, row_idx) {
  if (!length(row_idx) ||
      (length(row_idx) > 1L && any(diff(row_idx) <= 0L))) {
    return(NULL)
  }

  reader_state <- state$arrow_reader
  first_row <- row_idx[[1L]]
  if (first_row < reader_state$next_row) {
    return(NULL)
  }
  if (is.null(reader_state$reader)) {
    reader_state$reader <- dataview_arrow_reader_open(state$data)
  }
  if (first_row > reader_state$next_row) {
    dataview_arrow_reader_take(
      reader_state,
      first_row - reader_state$next_row,
      collect = FALSE
    )
  }
  dataview_arrow_reader_select(reader_state, row_idx)
}

dataview_arrow_query_fetch <- function(state, row_idx) {
  if (!length(row_idx)) {
    return(dataview_schema(state$data))
  }

  if (!is.data.frame(state$data)) {
    page <- dataview_arrow_query_forward_slice(state, row_idx)
    if (!is.null(page)) {
      return(page)
    }
    page <- dataview_arrow_fragment_slice(state, row_idx)
    if (!is.null(page)) {
      return(page)
    }
  }
  dataview_slice(state$data, row_idx)
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

  page <- dataview_arrow_bind_pages(pages)
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
          reader_state$reader <- dataview_arrow_reader_open(state$data)
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
  dataview_arrow_bind_pages(pages)
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
    reader_state$reader <- dataview_arrow_reader_open(state$data)
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

  # Prefetch larger display blocks for the current query. Filter-only blocks
  # continue through one forward reader; sorted/random blocks use fragment-local
  # row positions when the source is a multi-file FileSystemDataset.
  reader_state <- state$arrow_reader
  block_size <- if (isTRUE(state$query_has_sort)) {
    dataview_arrow_query_block_size
  } else {
    dataview_arrow_cache_block_size
  }
  block_starts <- unique(
    (display_idx - 1L) %/% block_size * block_size + 1L
  )
  pages <- lapply(block_starts, function(block_start) {
    block_end <- min(
      length(state$query_indices),
      block_start + block_size - 1L
    )
    cached <- dataview_arrow_query_cache_get(
      reader_state, state$query_key, block_start
    )
    if (is.null(cached)) {
      block_display_idx <- seq.int(block_start, block_end)
      cached <- dataview_arrow_query_fetch(
        state, state$query_indices[block_display_idx]
      )
      dataview_arrow_query_cache_add(
        reader_state, state$query_key, block_start, cached
      )
    }
    selected <- display_idx[display_idx >= block_start & display_idx <= block_end]
    cached[selected - block_start + 1L, , drop = FALSE]
  })
  if (length(pages) == 1L) return(pages[[1L]])
  dataview_arrow_bind_pages(pages)
}
