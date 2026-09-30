# Lazy Arrow support for the data viewer

dataview_is_arrow_lazy <- function(data) {
  inherits(data, "Dataset") ||
    inherits(data, "arrow_dplyr_query")
}

dataview_arrow_reader_batch_size <- 5000L
dataview_arrow_cache_block_size <- 1000L
dataview_arrow_sort_block_size <- 5000L
dataview_arrow_cache_rows <- 20000L

dataview_arrow_require <- function() {
  if (!requireNamespace("arrow", quietly = TRUE)) {
    stop("Viewing Arrow datasets requires the optional 'arrow' package")
  }
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

dataview_arrow_conversion <- function(data) {
  if (is.data.frame(data)) return(integer())
  schema <- getExportedValue("arrow", "infer_schema")(data)
  which(vapply(schema$fields, function(field) {
    inherits(
      field$type, c("Int64Type", "Date32Type", "Date64Type", "TimestampType", "DurationType")
    )
  }, logical(1)))
}

dataview_arrow_data_frame <- function(data, conversion = NULL) {
  old_options <- options(arrow.int64_downcast = FALSE)
  on.exit(options(old_options), add = TRUE)

  page <- as.data.frame(data, optional = TRUE)
  if (inherits(data, "ArrowTabular")) {
    if (is.null(conversion)) conversion <- dataview_arrow_conversion(data)
    for (position in conversion) {
      values <- tryCatch(as.vector(data[[position]]), error = function(e) NULL)
      if (!is.null(values) && length(values) == nrow(page)) {
        page[[position]] <- values
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
  if (is.data.frame(template)) {
    # Struct columns contain rows, not a list of fields to concatenate.
    return(dataview_arrow_bind_pages(values))
  }
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

dataview_arrow_reader_state <- function(data = NULL) {
  dataview_arrow_require()
  state <- new.env(parent = emptyenv())
  state$reader <- NULL
  # Current RecordBatch buffer from the forward Arrow reader.
  state$batch <- NULL
  state$batch_row <- 0L
  state$next_row <- 1L
  # Source-row cache used by normal forward/backward scrolling.
  state$row_cache <- list()
  # Display-row cache keyed by filter/sort query and display block.
  state$query_cache <- list()
  state$fragment_index <- NULL
  state$row_group_index <- NULL
  state$source_conversion <- if (!is.null(data)) dataview_arrow_conversion(data) else NULL
  state$conversion <- state$source_conversion
  state$projection <- NULL
  state$page_data <- NULL
  state
}

dataview_arrow_cache_get <- function(reader_state, row_idx) {
  # Reuse cached source rows for normal scrolling without rescanning Arrow.
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
  # Reuse cached display blocks for the current filter/sort result.
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

dataview_arrow_page_state <- function(state, fields = NULL) {
  positions <- dataview_page_positions(state, fields)
  reader_state <- state$arrow_reader
  if (!identical(positions, reader_state$projection)) {
    dataview_arrow_reader_reset(state)
    reader_state$row_cache <- list()
    reader_state$query_cache <- list()
    reader_state$page_data <- if (length(positions) && length(positions) < ncol(state$data)) {
      if (inherits(state$data, "arrow_dplyr_query")) {
        dplyr::select(
          dplyr::ungroup(dplyr::collapse(state$data)),
          dplyr::all_of(names(state$data)[positions])
        )
      } else {
        state$data$WithSchema(state$data$schema[names(state$data)[positions]])
      }
    } else {
      state$data
    }
    reader_state$projection <- positions
    conversion <- match(reader_state$source_conversion, positions, nomatch = 0L)
    reader_state$conversion <- conversion[conversion > 0L]
  }
  state$arrow_source <- state$data
  state$data <- reader_state$page_data
  state$columns <- state$columns[c(1L, positions + 1L)]
  state$column_fields <- as.character(positions)
  state
}

dataview_arrow_query_columns <- function(state, sort_model, filter_model) {
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
  positions <- unique(positions)
  if (!length(positions)) return(list())
  names <- names(state$data)[positions - 1L]
  reader <- if (inherits(state$data, "arrow_dplyr_query")) {
    dataview_arrow_reader_open(
      dplyr::select(
        dplyr::ungroup(dplyr::collapse(state$data)),
        dplyr::all_of(names)
      )
    )
  } else {
    getExportedValue("arrow", "Scanner")$create(
      state$data,
      projection = names,
      batch_size = dataview_arrow_reader_batch_size
    )$ToRecordBatchReader()
  }
  on.exit(try(reader$Close(), silent = TRUE), add = TRUE)
  conversion <- match(state$arrow_reader$source_conversion, positions - 1L, nomatch = 0L)
  columns <- dataview_arrow_data_frame(reader$read_table(), conversion[conversion > 0L])
  setNames(as.list(columns), as.character(positions))
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
  while (is.null(reader_state$batch) ||
           reader_state$batch_row >= nrow(reader_state$batch)) {
    reader_state$batch <- reader_state$reader$read_next_batch()
    reader_state$batch_row <- 0L
    if (is.null(reader_state$batch)) return(FALSE)
  }
  TRUE
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
          reader_state$batch$Slice(reader_state$batch_row, take), reader_state$conversion
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
        reader_state$batch[positions, , drop = FALSE], reader_state$conversion
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

dataview_arrow_fragment_index <- function(state) {
  reader_state <- state$arrow_reader
  if (isFALSE(reader_state$fragment_index)) {
    return(NULL)
  }
  if (!is.null(reader_state$fragment_index)) {
    return(reader_state$fragment_index)
  }

  data <- state$arrow_source %||% state$data
  files <- if (inherits(data, "FileSystemDataset")) data$files else character()
  if (length(files) < 2L) {
    reader_state$fragment_index <- FALSE
    return(NULL)
  }

  FileSystemDatasetFactory <- getExportedValue(
    "arrow", "FileSystemDatasetFactory"
  )
  filesystem <- data$filesystem
  format <- data$format
  schema <- data$schema
  fields <- names(schema)
  missing_columns <- vector("list", length(files))
  fragments <- lapply(seq_along(files), function(i) {
    tryCatch(
      {
        factory <- FileSystemDatasetFactory$create(
          filesystem,
          paths = files[[i]],
          format = format
        )
        missing_columns[[i]] <<- setdiff(fields, names(factory$Inspect()))
        factory$Finish(schema = schema)
      },
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
  missing_columns <- missing_columns[keep]
  counts <- counts[keep]
  ends <- cumsum(counts)
  starts <- if (length(counts)) c(1, head(ends, -1L) + 1) else numeric()

  # R does not expose a Dataset's fragment partition expressions. A field
  # absent from a physical file is either a partition constant or a null field
  # introduced by schema unification. Sample those values from the ORIGINAL
  # dataset, retaining directory/Hive partitioning and the declared field types.
  # Only one row per nonempty file and the missing fields are materialized.
  missing_names <- unique(unlist(missing_columns, use.names = FALSE))
  partition_values <- if (length(missing_names)) {
    dataview_slice(data$WithSchema(schema[missing_names]), starts)
  } else {
    NULL
  }

  reader_state$fragment_index <- list(
    datasets = fragments,
    starts = starts,
    ends = ends,
    missing_columns = missing_columns,
    partition_values = partition_values
  )
  reader_state$fragment_index
}

dataview_arrow_fragment_slice <- function(state, row_idx) {
  # Read requested rows from only the dataset files that contain them.
  index <- dataview_arrow_fragment_index(state)
  if (is.null(index) || !length(row_idx)) {
    return(NULL)
  }

  fragment_pos <- findInterval(row_idx - 1, index$ends) + 1L
  if (any(fragment_pos < 1L | fragment_pos > length(index$datasets))) {
    return(NULL)
  }

  # Use one Arrow scan over ONLY the selected files, in their source order.
  # This avoids one scanner/conversion per file for widely scattered sorts.
  fragments <- sort(unique(fragment_pos))
  counts <- index$ends[fragments] - index$starts[fragments] + 1
  starts <- c(1, head(cumsum(counts), -1L) + 1)
  selected_idx <- row_idx - index$starts[fragment_pos] +
    starts[match(fragment_pos, fragments)]
  data <- if (length(fragments) == 1L) {
    index$datasets[[fragments]]
  } else {
    getExportedValue("arrow", "open_dataset")(index$datasets[fragments])
  }
  if (!is.null(state$column_fields)) data <- data$WithSchema(state$data$schema)
  page <- dataview_slice(data, selected_idx, state$arrow_reader$conversion)

  for (name in intersect(names(index$partition_values), names(page))) {
    missing <- vapply(index$missing_columns, function(fields) name %in% fields, logical(1))
    positions <- which(missing[fragment_pos])
    if (is.data.frame(page[[name]])) {
      page[[name]][positions, ] <-
        index$partition_values[[name]][fragment_pos[positions], , drop = FALSE]
    } else {
      page[[name]][positions] <- index$partition_values[[name]][fragment_pos[positions]]
    }
  }
  page
}

dataview_arrow_row_group_index <- function(state) {
  reader_state <- state$arrow_reader
  if (isFALSE(reader_state$row_group_index)) return(NULL)
  if (!is.null(reader_state$row_group_index)) return(reader_state$row_group_index)

  data <- state$arrow_source %||% state$data
  files <- if (inherits(data, "FileSystemDataset")) data$files else character()
  if (length(files) != 1L || !identical(data$format$type, "parquet")) {
    reader_state$row_group_index <- FALSE
    return(NULL)
  }

  reader <- tryCatch(
    getExportedValue("arrow", "ParquetFileReader")$create(
      data$filesystem$OpenInputFile(files[[1L]])
    ),
    error = function(e) NULL
  )
  if (is.null(reader) || reader$num_row_groups < 2L) {
    reader_state$row_group_index <- FALSE
    return(NULL)
  }

  groups <- seq_len(reader$num_row_groups) - 1L
  counts <- vapply(
    groups,
    function(group) as.numeric(reader$ReadRowGroup(group, integer())$num_rows),
    numeric(1)
  )
  if (any(!is.finite(counts)) || sum(counts) != state$total_rows) {
    reader_state$row_group_index <- FALSE
    return(NULL)
  }

  ends <- cumsum(counts)
  starts <- c(1, head(ends, -1L) + 1)
  fields <- names(reader$GetSchema())
  missing_names <- setdiff(names(data), fields)
  partition_values <- if (length(missing_names)) {
    dataview_slice(data$WithSchema(data$schema[missing_names]), 1L)
  } else {
    NULL
  }

  reader_state$row_group_index <- list(
    reader = reader,
    starts = starts,
    ends = ends,
    fields = fields,
    partition_values = partition_values
  )
  reader_state$row_group_index
}

dataview_arrow_row_group_slice <- function(state, row_idx) {
  # Read requested rows directly from the Parquet row groups that contain them.
  index <- dataview_arrow_row_group_index(state)
  if (is.null(index) || !length(row_idx)) return(NULL)

  group_pos <- findInterval(row_idx - 1, index$ends) + 1L
  if (any(group_pos < 1L | group_pos > length(index$ends))) return(NULL)

  groups <- sort(unique(group_pos))
  counts <- index$ends[groups] - index$starts[groups] + 1
  starts <- c(1, head(cumsum(counts), -1L) + 1)
  selected_idx <- row_idx - index$starts[group_pos] +
    starts[match(group_pos, groups)]

  fields <- names(state$data)
  columns <- match(fields, index$fields)
  present <- !is.na(columns)
  page <- if (any(present)) {
    dataview_arrow_data_frame(index$reader$ReadRowGroups(
      groups - 1L, as.integer(columns[present] - 1L)
    ))
  } else {
    data.frame(row.names = seq_len(sum(counts)))
  }

  for (name in fields[!present]) {
    value <- index$partition_values[[name]]
    if (is.null(value)) return(NULL)
    page[[name]] <- if (is.data.frame(value)) {
      value[rep(1L, nrow(page)), , drop = FALSE]
    } else {
      value[rep(1L, nrow(page))]
    }
  }
  page <- page[, fields, drop = FALSE]
  page[selected_idx, , drop = FALSE]
}

dataview_arrow_query_forward_slice <- function(state, row_idx) {
  # Reuse the forward reader when requested source rows can be reached efficiently.
  if (!length(row_idx) ||
        (length(row_idx) > 1L && any(diff(row_idx) <= 0L))) {
    return(NULL)
  }

  reader_state <- state$arrow_reader
  first_row <- row_idx[[1L]]
  if (first_row < reader_state$next_row) {
    return(NULL)
  }
  if (inherits(state$data, "FileSystemDataset") &&
        (!isFALSE(reader_state$fragment_index) ||
           !isFALSE(reader_state$row_group_index)) &&
        tail(row_idx, 1L) - reader_state$next_row >
          length(row_idx) + dataview_arrow_reader_batch_size) {
    # A distant or sparse request should not consume all preceding data.
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
  # Choose the cheapest Arrow path for fetching the requested source rows.
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
    page <- dataview_arrow_row_group_slice(state, row_idx)
    if (!is.null(page)) {
      return(page)
    }
  }
  dataview_slice(state$data, row_idx, state$arrow_reader$conversion)
}

dataview_arrow_block_slice <- function(state, row_idx) {
  # Fetch contiguous source rows in cache-sized blocks for normal scrolling.
  reader_state <- state$arrow_reader
  pages <- list()
  block_starts <- dataview_block_starts(
    row_idx, dataview_arrow_cache_block_size
  )

  for (block_start in block_starts) {
    block_end <- min(
      state$total_rows,
      block_start + dataview_arrow_cache_block_size - 1L
    )
    block_row_idx <- seq.int(block_start, block_end)
    cached <- dataview_arrow_cache_get(reader_state, block_row_idx)

    if (is.null(cached)) {
      cached <- dataview_arrow_query_fetch(state, block_row_idx)
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
  # Fetch source rows directly, using block caching for contiguous requests.
  if (!length(row_idx)) {
    return(dataview_schema(state$data))
  }
  reader_state <- state$arrow_reader

  if (length(row_idx) == 1L || all(diff(row_idx) == 1L)) {
    return(dataview_arrow_block_slice(state, row_idx))
  }

  cached <- dataview_arrow_cache_get(reader_state, row_idx)
  if (!is.null(cached)) {
    return(cached)
  }

  page <- dataview_arrow_query_fetch(state, row_idx)
  dataview_arrow_cache_add(reader_state, row_idx, page)
  page
}

dataview_arrow_query_slice <- function(state, display_idx) {
  # Fetch filtered/sorted display rows using query-specific cached blocks.
  if (!length(display_idx)) {
    return(dataview_schema(state$data))
  }

  # Prefetch larger display blocks; random Dataset pages use file fragments or
  # Parquet row groups when available.
  reader_state <- state$arrow_reader
  block_size <- if (isTRUE(state$query_has_sort)) {
    dataview_arrow_sort_block_size
  } else {
    dataview_arrow_cache_block_size
  }
  block_starts <- dataview_block_starts(display_idx, block_size)
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
