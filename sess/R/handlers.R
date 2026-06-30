# Handlers for the client Pull Requests (HTTP GET/POST)

capture_str <- function(object, max_level = 0L) {
  paste0(utils::capture.output(
    utils::str(object,
      max.level = max_level,
      give.attr = FALSE,
      vec.len = 1L
    )
  ), collapse = "\n")
}

try_capture_str <- function(object, max_level = 0L) {
  tryCatch(
    capture_str(object, max_level),
    error = function(e) paste0(class(object), collapse = ", ")
  )
}

workspace_child_count <- function(object) {
  if (is.environment(object)) {
    length(object)
  } else if (isS4(object)) {
    length(methods::slotNames(object))
  } else if (typeof(object) %in% c("list", "pairlist")) {
    length(object)
  } else {
    0L
  }
}

get_workspace_data <- function() {
  env <- .GlobalEnv
  all_names <- ls(env, sorted = FALSE)

  objs <- lapply(all_names, function(name) {
    if (bindingIsActive(name, env)) {
      return(list(
        class = "active_binding",
        type = "active_binding",
        length = 0L,
        str = "(active-binding)",
        has_children = FALSE
      ))
    }

    obj <- env[[name]]
    obj_class <- class(obj)
    obj_type <- typeof(obj)
    obj_length <- length(obj)
    obj_dim <- dim(obj)
    first_class <- if (length(obj_class)) obj_class[[1]] else obj_type
    info <- list(
      class = class(obj),
      type = obj_type,
      length = obj_length,
      str = if (!is.null(obj_dim)) {
        paste0(first_class, ": ", paste(obj_dim, collapse = " x "))
      } else if (obj_type == "environment") {
        "<environment>"
      } else if (obj_type %in% c("closure", "builtin")) {
        trimws(try_capture_str(obj))
      } else {
        paste0(first_class, ", length ", obj_length)
      },
      has_children = workspace_child_count(obj) > 0L
    )

    obj_names <- if (is.object(obj)) {
      utils::.DollarNames(obj, pattern = "")
    } else if (is.recursive(obj)) {
      names(obj)
    } else {
      NULL
    }
    if (length(obj_names)) {
      info$names <- obj_names
    }
    if (isS4(obj)) {
      info$slots <- methods::slotNames(obj)
    }
    if (!is.null(obj_dim)) {
      info$dim <- obj_dim
    }
    info
  })
  names(objs) <- all_names

  list(
    globalenv = objs,
    search = search()[-1],
    loaded_namespaces = loadedNamespaces()
  )
}

workspace_object <- function(name, path = list()) {
  object <- get(name, envir = .GlobalEnv, inherits = FALSE)
  for (selector in path) {
    object <- switch(selector$kind,
      index = object[[as.integer(selector$value)]],
      name = get(selector$value, envir = object, inherits = FALSE),
      slot = methods::slot(object, selector$value),
      stop("Unknown workspace selector")
    )
  }
  object
}

workspace_child_page_size <- 500L

workspace_child_item <- function(object, str, selector) {
  list(
    str = str,
    class = paste(class(object), collapse = ", "),
    type = typeof(object),
    has_children = workspace_child_count(object) > 0L,
    selector = selector
  )
}

workspace_child_label <- function(name, index) {
  if (!is.null(name) && !is.na(name) && nzchar(name)) {
    paste0("$ ", name)
  } else {
    paste0("[[", index, "]]")
  }
}

get_workspace_children <- function(name, path = list(), start = 1L) {
  tryCatch({
    object <- workspace_object(name, path)
    child_count <- workspace_child_count(object)
    if (child_count == 0L) {
      return(list(children = I(list()), next_start = NULL))
    }

    start <- max(1L, as.integer(start))
    end <- min(child_count, start + workspace_child_page_size - 1L)
    if (start > end) {
      return(list(children = I(list()), next_start = NULL))
    }

    children <- if (is.environment(object)) {
      child_names <- ls(object, sorted = FALSE)[seq.int(start, end)]
      lapply(child_names, function(child_name) {
        if (bindingIsActive(child_name, object)) {
          list(
            str = paste0("$ ", child_name, ": (active-binding)"),
            class = "active_binding",
            type = "active_binding",
            has_children = FALSE
          )
        } else {
          child <- get(child_name, envir = object, inherits = FALSE)
          workspace_child_item(
            child,
            paste0("$ ", child_name, ": ", trimws(try_capture_str(child))),
            list(kind = "name", value = child_name)
          )
        }
      })
    } else if (isS4(object)) {
      child_names <- methods::slotNames(object)[seq.int(start, end)]
      lapply(child_names, function(child_name) {
        child <- methods::slot(object, child_name)
        workspace_child_item(
          child,
          paste0("@ ", child_name, ": ", trimws(try_capture_str(child))),
          list(kind = "slot", value = child_name)
        )
      })
    } else {
      indices <- seq.int(start, end)
      child_names <- names(object)
      lapply(indices, function(index) {
        child <- object[[index]]
        child_name <- if (is.null(child_names)) NULL else child_names[[index]]
        workspace_child_item(
          child,
          paste0(
            workspace_child_label(child_name, index),
            ": ",
            trimws(try_capture_str(child))
          ),
          list(kind = "index", value = index)
        )
      })
    }

    list(
      children = I(children),
      next_start = if (end < child_count) end + 1L else NULL
    )
  }, error = function(e) list(children = I(list()), next_start = NULL))
}

handle_hover <- function(expr_str) {
  tryCatch(
    {
      expr <- parse(text = expr_str, keep.source = FALSE)[[1]]
      obj <- eval(expr, .GlobalEnv)
      list(str = capture_str(obj))
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

  if (trigger == "@" && isS4(obj)) {
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

get_column_def <- function(name, field, value) {
  tooltip <- sprintf(
    "%s, class: [%s], type: %s",
    name,
    toString(class(value)),
    typeof(value)
  )
  units <- attr(value, "units", exact = TRUE)
  if (!is.null(units)) {
    tooltip <- sprintf("%s, units: %s", tooltip, toString(units))
  }
  if (is.numeric(value)) {
    type <- "numericColumn"
    filter <- "agNumberColumnFilter"
  } else if (inherits(value, "Date") ||
               inherits(value, "POSIXct") ||
               inherits(value, "POSIXlt")) {
    type <- "dateColumn"
    filter <- "agDateColumnFilter"
  } else if (is.logical(value)) {
    type <- "booleanColumn"
    filter <- TRUE
  } else {
    type <- "textColumn"
    filter <- "agTextColumnFilter"
  }
  sortable <- !is.complex(value) &&
    !(is.list(value) && !inherits(value, "POSIXlt")) &&
    !is.raw(value)
  if (identical(field, "0")) {
    sortable <- FALSE
    filter <- FALSE
  }
  if (!sortable) {
    filter <- FALSE
  }
  col_def <- list(
    headerName = jsonlite::unbox(name),
    headerTooltip = jsonlite::unbox(tooltip),
    field = jsonlite::unbox(field),
    type = jsonlite::unbox(type),
    filter = jsonlite::unbox(filter),
    sortable = jsonlite::unbox(sortable)
  )
  if (is.logical(value)) {
    col_def$cellDataType <- jsonlite::unbox("boolean")
  }
  if (identical(field, "0")) {
    col_def$suppressHeaderMenuButton <- jsonlite::unbox(TRUE)
  }
  col_def
}

dataview_is_table <- function(data) {
  is.data.frame(data) ||
    is.matrix(data) ||
    inherits(data, "ArrowTabular") ||
    inherits(data, "polars_data_frame")
}

dataview_schema <- function(data) {
  if (inherits(data, "ArrowTabular")) {
    return(data$Slice(0L, 0L)$to_data_frame())
  }
  if (inherits(data, "polars_data_frame")) {
    return(as.data.frame(data$slice(0L, 0L)))
  }
  data[0, , drop = FALSE]
}

dataview_slice <- function(data, row_idx) {
  if (inherits(data, "ArrowTabular")) {
    if (!length(row_idx)) {
      return(data$Slice(0L, 0L)$to_data_frame())
    }
    return(data[row_idx, ]$to_data_frame())
  }
  if (inherits(data, "polars_data_frame")) {
    if (!length(row_idx)) {
      return(as.data.frame(data$slice(0L, 0L)))
    }
    if (length(row_idx) == 1L || all(diff(row_idx) == 1L)) {
      return(as.data.frame(data$slice(row_idx[[1L]] - 1L, length(row_idx))))
    }
    return(as.data.frame(data[row_idx, ]))
  }
  if (is.matrix(data) && is.object(data)) {
    page <- lapply(seq_len(ncol(data)), function(position) {
      dataview_column(data, position)[row_idx]
    })
    names(page) <- colnames(data)
    return(as.data.frame(page, optional = TRUE))
  }
  data[row_idx, , drop = FALSE]
}

dataview_column <- function(data, position) {
  if (inherits(data, "ArrowTabular")) {
    return(as.vector(data[[position]]))
  }
  if (inherits(data, "polars_data_frame")) {
    return(as.data.frame(data[, position])[[1L]])
  }
  if (is.matrix(data)) {
    return(data[, position])
  }
  data[[position]]
}

dataview_to_state <- function(data) {
  if (!dataview_is_table(data)) {
    stop("data must be a data frame, matrix, Arrow table, or Polars data frame")
  }

  n <- nrow(data)
  colnames <- if (inherits(data, "ArrowTabular") ||
                    inherits(data, "polars_data_frame")) {
    names(data)
  } else {
    colnames(data)
  }
  if (is.null(colnames)) {
    colnames <- sprintf("(X%d)", seq_len(ncol(data)))
  } else {
    colnames <- trimws(colnames)
  }

  row_index <- if (is.data.frame(data) && .row_names_info(data) > 0L) {
    rownames(data)
  } else if (is.matrix(data)) {
    row_index <- rownames(data)
    if (is.null(row_index)) NULL else trimws(row_index)
  } else {
    NULL
  }

  headers <- c(" ", colnames)
  fields <- as.character(seq_along(headers) - 1L)
  schema <- dataview_schema(data)
  cols <- c(
    list(if (is.null(row_index)) integer() else character()),
    lapply(seq_len(ncol(schema)), function(position) {
      dataview_column(schema, position)
    })
  )

  list(
    data = data,
    row_index = row_index,
    columns = .mapply(
      get_column_def,
      list(headers, fields, cols),
      NULL
    ),
    total_rows = n,
    query_key = NULL,
    query_indices = NULL
  )
}

dataview_columns <- function(state) {
  state$columns
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

dataview_column_values <- function(state, position, row_idx = NULL) {
  if (position == 1L) {
    if (is.null(state$row_index)) {
      return(if (is.null(row_idx)) seq_len(state$total_rows) else row_idx)
    }
    return(if (is.null(row_idx)) state$row_index else state$row_index[row_idx])
  }

  values <- dataview_column(state$data, position - 1L)
  if (is.null(row_idx)) values else values[row_idx]
}

dataview_match_condition <- function(values, cond) {
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

  if (is.logical(values) && cond_type == "true") {
    result <- !is.na(values) & values
  } else if (is.logical(values) && cond_type == "false") {
    result <- !is.na(values) & !values
  } else if (inherits(values, "Date") ||
               inherits(values, "POSIXct") ||
               inherits(values, "POSIXlt")) {
    ds <- as.Date(values)
    d1 <- as.Date(if (is.null(cond$dateFrom)) cond$filter else cond$dateFrom)
    d2 <- as.Date(if (is.null(cond$dateTo)) cond$filterTo else cond$dateTo)
    result <- switch(cond_type,
      equals = ds == d1,
      notEqual = ds != d1,
      greaterThan = ds > d1,
      greaterThanOrEqual = ds >= d1,
      lessThan = ds < d1,
      lessThanOrEqual = ds <= d1,
      inRange = ds >= d1 & ds <= d2,
      rep(TRUE, length(values))
    )
  } else if (is.numeric(values) || is.logical(values)) {
    nums <- as.numeric(values)
    f1 <- suppressWarnings(as.numeric(cond$filter))
    f2 <- suppressWarnings(as.numeric(cond$filterTo))
    result <- switch(cond_type,
      equals = nums == f1,
      notEqual = nums != f1,
      greaterThan = nums > f1,
      greaterThanOrEqual = nums >= f1,
      lessThan = nums < f1,
      lessThanOrEqual = nums <= f1,
      inRange = nums >= f1 & nums <= f2,
      rep(TRUE, length(values))
    )
  } else {
    text <- tolower(as.character(values))
    filter_value <- tolower(as.character(cond$filter %||% ""))
    result <- switch(cond_type,
      equals = text == filter_value,
      notEqual = text != filter_value,
      contains = grepl(filter_value, text, fixed = TRUE),
      notContains = !grepl(filter_value, text, fixed = TRUE),
      startsWith = startsWith(text, filter_value),
      endsWith = endsWith(text, filter_value),
      rep(TRUE, length(values))
    )
  }

  result[is.na(result)] <- FALSE
  result
}

dataview_filter_values <- function(values, model) {
  conditions <- model$conditions
  if (is.null(conditions) && !is.null(model$condition1)) {
    conditions <- Filter(Negate(is.null), list(model$condition1, model$condition2))
  }
  if (is.null(conditions) || !length(conditions)) {
    return(dataview_match_condition(values, model))
  }

  matches <- lapply(conditions, function(cond) {
    dataview_match_condition(values, cond)
  })
  if (identical(toupper(model$operator), "OR")) {
    Reduce(`|`, matches)
  } else {
    Reduce(`&`, matches)
  }
}

`%||%` <- function(x, y) {
  if (is.null(x)) y else x
}

dataview_field_position <- function(field, column_count) {
  position <- suppressWarnings(as.integer(field)) + 1L
  if (is.na(position) || position < 1L || position > column_count) {
    return(NA_integer_)
  }
  position
}

dataview_apply_filter_model <- function(state, filter_model, row_idx) {
  if (is.null(filter_model) || !length(filter_model)) {
    return(row_idx)
  }

  matched <- rep(TRUE, length(row_idx))

  for (col_id in names(filter_model)) {
    col_model <- filter_model[[col_id]]
    col_pos <- dataview_field_position(col_id, length(state$columns))
    if (is.na(col_pos)) {
      next
    }
    if (isFALSE(state$columns[[col_pos]]$filter)) {
      next
    }

    values <- dataview_column_values(state, col_pos, row_idx)
    column_match <- dataview_filter_values(values, col_model)
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
    col_pos <- dataview_field_position(col_id, length(state$columns))
    if (is.na(col_pos)) {
      next
    }
    if (isFALSE(state$columns[[col_pos]]$sortable)) {
      next
    }

    raw_values <- dataview_column_values(state, col_pos, row_idx)
    is_desc <- identical(as.character(sort_item$sort), "desc")
    sort_vec <- if (is.factor(raw_values) && !is.ordered(raw_values)) {
      as.character(raw_values)
    } else {
      raw_values
    }

    sort_specs[[length(sort_specs) + 1L]] <- list(
      values = sort_vec,
      decreasing = is_desc
    )
  }

  if (!length(sort_specs)) {
    return(row_idx)
  }

  order_args <- lapply(sort_specs, function(spec) spec$values)
  order_args[[length(order_args) + 1L]] <- row_idx
  decreasing <- vapply(sort_specs, function(spec) spec$decreasing, logical(1L))
  decreasing <- c(decreasing, FALSE)
  args <- c(order_args, list(
    na.last = TRUE,
    decreasing = decreasing,
    method = "radix"
  ))
  row_idx[do.call(order, args)]
}

dataview_query_key <- function(sort_model, filter_model) {
  jsonlite::toJSON(
    list(
      sortModel = if (is.null(sort_model) || !length(sort_model)) NULL else sort_model,
      filterModel = if (is.null(filter_model) || !length(filter_model)) NULL else filter_model
    ),
    auto_unbox = TRUE,
    null = "null",
    force = TRUE
  )
}

dataview_query_indices <- function(state, sort_model, filter_model) {
  if ((is.null(sort_model) || !length(sort_model)) &&
        (is.null(filter_model) || !length(filter_model))) {
    return(NULL)
  }

  row_idx <- seq_len(state$total_rows)
  row_idx <- dataview_apply_filter_model(state, filter_model, row_idx)
  dataview_apply_sort_model(state, sort_model, row_idx)
}

dataview_rows <- function(state, row_idx) {
  page <- dataview_slice(state$data, row_idx)
  rows <- cbind(
    data.frame(
      dataview_column_values(state, 1L, row_idx),
      check.names = FALSE
    ),
    page
  )
  names(rows) <- as.character(seq_len(ncol(rows)) - 1L)
  rownames(rows) <- NULL
  rows
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

  sort_model <- params$sortModel %||% list()
  filter_model <- params$filterModel %||% list()
  query_key <- dataview_query_key(sort_model, filter_model)
  if (!identical(query_key, state$query_key)) {
    state$query_key <- query_key
    state$query_indices <- dataview_query_indices(state, sort_model, filter_model)
    .sess_env$dataviews[[view_id]] <- state
  }

  total <- if (is.null(state$query_indices)) {
    state$total_rows
  } else {
    length(state$query_indices)
  }
  end_exclusive <- min(total, end_row)
  if (start_row >= total || start_row >= end_exclusive) {
    display_idx <- integer(0)
    page_idx <- integer(0)
  } else {
    display_idx <- seq.int(start_row + 1L, end_exclusive)
    page_idx <- if (is.null(state$query_indices)) {
      display_idx
    } else {
      state$query_indices[display_idx]
    }
  }

  list(
    rows = dataview_rows(state, page_idx),
    totalRows = total,
    totalUnfiltered = state$total_rows,
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
