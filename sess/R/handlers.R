# Handlers for the client Pull Requests (HTTP GET/POST)

get_workspace_data <- function() {
  env <- .GlobalEnv
  all_names <- ls(env)

  objs <- lapply(all_names, function(name) {
    obj <- env[[name]]
    list(
      class = class(obj),
      type = typeof(obj),
      length = length(obj),
      # Create a concise string representation
      str = paste0(
        utils::capture.output(utils::str(obj, max.level = 0, give.attr = FALSE)),
        collapse = "\n"
      )
    )
  })
  names(objs) <- all_names

  list(
    globalenv = objs,
    search = search()[-1],
    loaded_namespaces = loadedNamespaces()
  )
}

handle_hover <- function(expr_str) {
  tryCatch(
    {
      expr <- parse(text = expr_str, keep.source = FALSE)[[1]]
      obj <- eval(expr, .GlobalEnv)
      str_preview <- paste0(
        utils::capture.output(utils::str(obj, max.level = 0, give.attr = FALSE)),
        collapse = "\n"
      )
      list(str = str_preview)
    },
    error = function(e) NULL
  )
}

handle_complete <- function(expr_str, trigger = NULL) {
  obj <- tryCatch(
    {
      expr <- parse(text = expr_str, keep.source = FALSE)[[1]]
      eval(expr, .GlobalEnv)
    },
    error = function(e) NULL
  )

  if (is.null(obj) || is.null(trigger)) {
    return(NULL)
  }

  if (trigger == "$") {
    nms <- if (is.object(obj)) {
      utils::.DollarNames(obj, pattern = "")
    } else if (is.recursive(obj)) {
      names(obj)
    } else {
      NULL
    }

    if (is.null(nms)) {
      return(NULL)
    }

    return(lapply(nms, function(n) {
      item <- obj[[n]]
      list(
        name = n,
        type = typeof(item),
        str = paste0(class(item), collapse = ", ")
      )
    }))
  }

  if (trigger == "@" && methods::isS4(obj)) {
    nms <- methods::slotNames(obj)
    return(lapply(nms, function(n) {
      item <- methods::slot(obj, n)
      list(
        name = n,
        type = typeof(item),
        str = paste0(class(item), collapse = ", ")
      )
    }))
  }

  NULL
}

handle_plot_latest <- function(params) {
  record <- .sess_env$latest_plot_record
  if (is.null(record)) {
    return(list(data = NULL))
  }

  width <- if (is.null(params$width)) 800 else as.numeric(params$width)
  height <- if (is.null(params$height)) 600 else as.numeric(params$height)
  format <- if (is.null(params$format)) "svglite" else as.character(params$format)

  plot_file <- tempfile(tmpdir = .sess_env$tempdir, fileext = paste0(".", format))

  dev_args <- params$devArgs
  if (is.null(dev_args)) {
    dev_args <- list()
  }
  # Remove arguments that we handle ourselves
  dev_args$filename <- NULL
  dev_args$file <- NULL
  dev_args$width <- NULL
  dev_args$height <- NULL
  dev_args$res <- NULL

  if (format == "svglite") {
    if (requireNamespace("svglite", quietly = TRUE)) {
      do.call(svglite::svglite, c(list(
        filename = plot_file, width = width / 72, height = height / 72
      ), dev_args))
    } else {
      # Fallback to png
      do.call(grDevices::png, c(list(
        filename = plot_file, width = width, height = height, res = 72
      ), dev_args))
    }
  } else {
    do.call(grDevices::png, c(list(
      filename = plot_file, width = width, height = height, res = 72
    ), dev_args))
  }

  on.exit({
    if (file.exists(plot_file)) unlink(plot_file)
  })

  grDevices::replayPlot(record)
  grDevices::dev.off()

  if (file.exists(plot_file)) {
    raw_img <- readBin(plot_file, "raw", file.info(plot_file)$size)
    list(
      data = as.character(jsonlite::base64_enc(raw_img)),
      format = if (format == "svglite" && !requireNamespace("svglite", quietly = TRUE)) {
        "png"
      } else {
        format
      }
    )
  } else {
    list(data = NULL)
  }
}

dataview_data_type <- function(x) {
  if (is.logical(x)) {
    "logical"
  } else if (is.factor(x)) {
    "factor"
  } else if (inherits(x, "POSIXct") || inherits(x, "POSIXlt")) {
    "datetime"
  } else if (inherits(x, "Date")) {
    "date"
  } else if (is.numeric(x)) {
    if (is.null(attr(x, "class"))) {
      "num"
    } else {
      "num-fmt"
    }
  } else {
    "string"
  }
}

dataview_to_state <- function(data) {
  if (is.data.frame(data)) {
    n <- nrow(data)
    colnames <- colnames(data)
    if (is.null(colnames)) {
      colnames <- sprintf("(X%d)", seq_len(ncol(data)))
    } else {
      colnames <- trimws(colnames)
    }
    if (.row_names_info(data) > 0L) {
      row_index <- rownames(data)
      rownames(data) <- NULL
    } else {
      row_index <- seq_len(n)
    }
    cols <- c(list(row_index), .subset(data))
    headers <- c(" ", colnames)
    types <- vapply(cols, dataview_data_type, character(1L), USE.NAMES = FALSE)
  } else if (is.matrix(data)) {
    if (is.factor(data)) {
      data <- format(data)
    }
    n <- nrow(data)
    colnames <- colnames(data)
    colnames(data) <- NULL
    if (is.null(colnames)) {
      colnames <- sprintf("(X%d)", seq_len(ncol(data)))
    } else {
      colnames <- trimws(colnames)
    }
    row_index <- rownames(data)
    rownames(data) <- NULL
    cols <- c(
      list(if (is.null(row_index)) seq_len(n) else trimws(row_index)),
      lapply(seq_len(ncol(data)), function(i) data[, i])
    )
    headers <- c(" ", colnames)
    matrix_type <- dataview_data_type(data)
    types <- c(if (is.null(row_index)) "num" else "string", rep(matrix_type, ncol(data)))
  } else {
    stop("data must be data.frame or matrix")
  }

  list(
    columns = cols,
    headers = headers,
    types = types,
    total_rows = length(cols[[1L]])
  )
}

dataview_columns <- function(state) {
  .mapply(function(title, type, index, col_data) {
    # Determine cell alignment: numeric/date types right-align, everything else left-align
    class <- if (type %in% c("num", "num-fmt", "date", "datetime")) "text-right" else "text-left"
    # Map R data types to ag-grid column types for proper filtering
    ag_type <- if (type == "date") {
      "dateColumn"
    } else if (type == "datetime") {
      "datetimeColumn"
    } else if (type %in% c("num", "num-fmt")) {
      "numberColumn"
    } else if (type %in% c("logical", "factor")) {
      "setColumn"
    } else {
      ""
    }

    col_def <- list(
      headerName = jsonlite::unbox(title),
      field = jsonlite::unbox(as.character(index - 1L)),
      cellClass = jsonlite::unbox(class),
      type = jsonlite::unbox(ag_type)
    )

    # For set filters, include unique values so ag-grid can show all options
    if (type %in% c("logical", "factor")) {
      unique_vals <- sort(unique(as.character(col_data)))
      unique_vals <- unique_vals[!is.na(unique_vals)]
      # Keep as vector, not list, so JSON serialization is [val1, val2, ...]
      col_def$filterParams <- list(values = I(unique_vals))
    }

    col_def
  }, list(state$headers, state$types, seq_along(state$headers), state$columns), NULL)
}

dataview_new_id <- function() {
  repeat {
    ts <- gsub("[^0-9]", "", format(Sys.time(), "%Y%m%d%H%M%OS6"), perl = TRUE)
    view_id <- sprintf("dv_%s_%06d", ts, sample.int(999999L, 1L))
    if (is.null(.sess_env$dataviews) || is.null(.sess_env$dataviews[[view_id]])) {
      return(view_id)
    }
  }
}

dataview_register <- function(data, view_id = NULL) {
  if (is.null(.sess_env$dataviews)) {
    .sess_env$dataviews <- list()
  }

  if (is.null(view_id)) {
    view_id <- dataview_new_id()
  }

  state <- dataview_to_state(data)
  .sess_env$dataviews[[view_id]] <- state
  list(
    view_id = view_id,
    total_rows = state$total_rows,
    columns = dataview_columns(state)
  )
}

dataview_get_state <- function(view_id) {
  if (is.null(.sess_env$dataviews) || is.null(.sess_env$dataviews[[view_id]])) {
    stop(sprintf("Unknown dataview id: %s", view_id))
  }
  .sess_env$dataviews[[view_id]]
}

dataview_match_condition <- function(values, cond, type_hint) {
  if (is.null(cond$type)) {
    return(rep(TRUE, length(values)))
  }

  cond_type <- as.character(cond$type)
  if (cond_type == "blank") {
    return(is.na(values) | trimws(as.character(values)) == "")
  }
  if (cond_type == "notBlank") {
    return(!(is.na(values) | trimws(as.character(values)) == ""))
  }

  # Determine filter type from cond or use hint
  filter_type <- if (!is.null(cond$filterType)) {
    as.character(cond$filterType)
  } else if (type_hint == "date") {
    "date"
  } else if (type_hint == "datetime") {
    "datetime"
  } else if (type_hint %in% c("num", "num-fmt")) {
    "number"
  } else if (type_hint %in% c("logical", "factor")) {
    "set"
  } else {
    "text"
  }

  if (filter_type == "number") {
    nums <- suppressWarnings(as.numeric(values))
    f1 <- suppressWarnings(as.numeric(cond$filter))
    f2 <- suppressWarnings(as.numeric(cond$filterTo))
    switch(cond_type,
      equals = nums == f1,
      notEqual = nums != f1,
      greaterThan = nums > f1,
      greaterThanOrEqual = nums >= f1,
      lessThan = nums < f1,
      lessThanOrEqual = nums <= f1,
      inRange = nums >= f1 & nums <= f2,
      rep(TRUE, length(values))
    )
  } else if (filter_type == "date") {
    as_dates <- function(x) {
      if (inherits(x, "Date")) {
        x
      } else {
        suppressWarnings(as.Date(as.character(x)))
      }
    }
    ds <- as_dates(values)
    d1 <- suppressWarnings(as.Date(cond$dateFrom %||% cond$filter))
    d2 <- suppressWarnings(as.Date(cond$dateTo %||% cond$filterTo))
    switch(cond_type,
      equals = ds == d1,
      notEqual = ds != d1,
      greaterThan = ds > d1,
      greaterThanOrEqual = ds >= d1,
      lessThan = ds < d1,
      lessThanOrEqual = ds <= d1,
      inRange = ds >= d1 & ds <= d2,
      rep(TRUE, length(values))
    )
  } else if (filter_type == "datetime") {
    as_datetimes <- function(x) {
      if (inherits(x, "POSIXct") || inherits(x, "POSIXlt")) {
        as.POSIXct(x)
      } else {
        suppressWarnings(as.POSIXct(as.character(x)))
      }
    }
    dts <- as_datetimes(values)
    dt1 <- suppressWarnings(as.POSIXct(cond$dateFrom %||% cond$filter))
    dt2 <- suppressWarnings(as.POSIXct(cond$dateTo %||% cond$filterTo))
    switch(cond_type,
      equals = dts == dt1,
      notEqual = dts != dt1,
      greaterThan = dts > dt1,
      greaterThanOrEqual = dts >= dt1,
      lessThan = dts < dt1,
      lessThanOrEqual = dts <= dt1,
      inRange = dts >= dt1 & dts <= dt2,
      rep(TRUE, length(values))
    )
  } else if (filter_type == "set") {
    # For set filters (logical, factor), ag-grid sends selected values
    if (!is.null(cond$values) && length(cond$values) > 0L) {
      # Convert to character for comparison
      text_values <- as.character(values)
      selected <- unlist(cond$values)
      match(text_values, selected, nomatch = 0L) > 0L
    } else {
      rep(TRUE, length(values))
    }
  } else {
    text <- tolower(as.character(values))
    filter_value <- tolower(as.character(cond$filter %||% ""))
    switch(cond_type,
      equals = text == filter_value,
      notEqual = text != filter_value,
      contains = grepl(filter_value, text, fixed = TRUE),
      notContains = !grepl(filter_value, text, fixed = TRUE),
      startsWith = startsWith(text, filter_value),
      endsWith = endsWith(text, filter_value),
      rep(TRUE, length(values))
    )
  }
}

`%||%` <- function(x, y) {
  if (is.null(x)) y else x
}

dataview_apply_filter_model <- function(state, filter_model, row_idx) {
  if (is.null(filter_model) || !length(filter_model)) {
    return(row_idx)
  }

  matched <- rep(TRUE, length(row_idx))

  for (col_id in names(filter_model)) {
    col_model <- filter_model[[col_id]]
    col_pos <- suppressWarnings(as.integer(col_id)) + 1L
    if (is.na(col_pos) || col_pos < 1L || col_pos > length(state$columns)) {
      next
    }

    values <- state$columns[[col_pos]][row_idx]
    type_hint <- state$types[[col_pos]]
    column_match <- rep(TRUE, length(values))

    if (!is.null(col_model$operator) &&
          !is.null(col_model$condition1) &&
          !is.null(col_model$condition2)) {
      left <- dataview_match_condition(values, col_model$condition1, type_hint)
      right <- dataview_match_condition(values, col_model$condition2, type_hint)
      op <- toupper(as.character(col_model$operator))
      column_match <- if (op == "OR") left | right else left & right
    } else {
      column_match <- dataview_match_condition(values, col_model, type_hint)
    }

    column_match[is.na(column_match)] <- FALSE
    matched <- matched & column_match
  }

  row_idx[matched]
}

dataview_apply_sort_model <- function(state, sort_model, row_idx) {
  if (is.null(sort_model) || !length(sort_model)) {
    return(row_idx)
  }

  sort_specs <- list()

  for (sort_item in sort_model) {
    col_id <- as.character(sort_item$colId %||% "")
    col_pos <- suppressWarnings(as.integer(col_id)) + 1L
    if (is.na(col_pos) || col_pos < 1L || col_pos > length(state$columns)) {
      next
    }
    raw_values <- state$columns[[col_pos]][row_idx]
    type_hint <- state$types[[col_pos]]
    is_desc <- identical(as.character(sort_item$sort), "desc")

    if (type_hint %in% c("num", "num-fmt")) {
      sort_vec <- suppressWarnings(as.numeric(raw_values))
    } else if (type_hint == "date") {
      sort_vec <- suppressWarnings(as.Date(as.character(raw_values)))
    } else {
      sort_vec <- tolower(as.character(raw_values))
    }

    sort_specs[[length(sort_specs) + 1L]] <- list(
      values = sort_vec,
      decreasing = is_desc
    )
  }

  if (!length(sort_specs)) {
    return(row_idx)
  }

  # Build arguments for order() with per-column decreasing handling.
  # R's order() doesn't support per-column decreasing, so transform values:
  # - For numeric: negate for descending
  # - For other types: negate rank for descending
  order_args <- list()
  for (i in seq_along(sort_specs)) {
    spec <- sort_specs[[i]]
    if (spec$decreasing) {
      if (is.numeric(spec$values)) {
        order_args[[i]] <- -spec$values
      } else {
        order_args[[i]] <- -rank(spec$values, na.last = "keep")
      }
    } else {
      order_args[[i]] <- spec$values
    }
  }
  order_args$na.last <- TRUE

  ord <- do.call(order, order_args)
  row_idx[ord]
}

dataview_rows <- function(state, row_idx) {
  if (!length(row_idx)) {
    return(list())
  }

  formatted_cols <- Map(function(col, type_hint) {
    if (type_hint == "date") {
      trimws(format(col[row_idx], "%Y-%m-%d"))
    } else {
      trimws(format(col[row_idx]))
    }
  }, state$columns, state$types)

  keys <- as.character(seq_along(formatted_cols) - 1L)
  lapply(seq_along(row_idx), function(i) {
    values <- lapply(formatted_cols, function(col) col[[i]])
    names(values) <- keys
    values
  })
}

handle_dataview_init <- function(params) {
  view_id <- as.character(params$view_id %||% "")
  state <- dataview_get_state(view_id)
  list(
    columns = dataview_columns(state),
    totalRows = state$total_rows
  )
}

handle_dataview_page <- function(params) {
  view_id <- as.character(params$view_id %||% "")
  state <- dataview_get_state(view_id)

  start_row <- suppressWarnings(as.integer(params$startRow %||% 0L))
  end_row <- suppressWarnings(as.integer(params$endRow %||% min(state$total_rows, 500L)))
  if (is.na(start_row) || start_row < 0L) {
    start_row <- 0L
  }
  if (is.na(end_row) || end_row < start_row) {
    end_row <- start_row
  }

  row_idx <- seq_len(state$total_rows)
  row_idx <- dataview_apply_filter_model(state, params$filterModel, row_idx)
  row_idx <- dataview_apply_sort_model(state, params$sortModel, row_idx)

  total <- length(row_idx)
  if (start_row >= total) {
    page_idx <- integer(0)
  } else {
    end_inclusive <- min(total, end_row)
    page_idx <- row_idx[(start_row + 1L):end_inclusive]
  }

  list(
    rows = dataview_rows(state, page_idx),
    totalRows = total,
    lastRow = total
  )
}

handle_dataview_dispose <- function(params) {
  view_id <- as.character(params$view_id %||% "")
  if (!is.null(.sess_env$dataviews) && !is.null(.sess_env$dataviews[[view_id]])) {
    .sess_env$dataviews[[view_id]] <- NULL
  }
  TRUE
}
