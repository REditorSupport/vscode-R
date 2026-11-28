# Interactive table and list displays shared by the native and webR runtimes.
.interactive_table_text <- function(value) {
  file <- tempfile("table-print-")
  on.exit(unlink(file))
  tryCatch(
    {
      # Use the class printer and current R options. A file bounds the amount we
      # retain in memory even when a custom printer produces a very large table.
      # Binary output keeps notebook newlines portable on Windows too.
      connection <- file(file, open = "wb")
      tryCatch(utils::capture.output(print(value), file = connection), finally = close(connection))
      limit <- 256L * 1024L
      text <- readChar(file, nchars = limit, useBytes = TRUE)
      if (!length(text)) {
        text <- ""
      }
      text <- iconv(text, to = "UTF-8", sub = "")
      if (file.info(file)$size > limit) {
        text <- paste0(text, "\n[Printed preview truncated at 256 KiB]\n")
      }
      list(printedText = text)
    },
    error = function(e) list(printError = conditionMessage(e))
  )
}

.interactive_table_snapshot <- function(value) {
  source_rows <- nrow(value)
  # Bound work before copying or invoking a class printer. Bounding the printed
  # bytes afterwards does not prevent a printer from scanning billions of rows.
  limit <- max(1L, min(1000L, floor(100000 / max(1L, ncol(value)))))
  truncated <- source_rows > limit
  # Row subsetting already allocates independent data.table columns. Calling
  # copy() afterwards also duplicates attributes and objects inside list cells.
  snapshot <- dataview_slice(value, seq_len(min(source_rows, limit)))
  if (is.data.frame(snapshot)) {
    for (position in seq_len(ncol(snapshot))) {
      column <- snapshot[[position]]
      if (is.list(column) && is.null(dim(column)) && !inherits(column, "POSIXlt")) {
        snapshot[[position]] <- lapply(column, dataview_cell_preview)
      } else if (is.character(column)) {
        snapshot[[position]] <- dataview_preview_text(column)
      }
    }
  } else if (is.character(snapshot)) {
    snapshot[] <- dataview_preview_text(snapshot)
  }
  list(value = snapshot, source_rows = source_rows, truncated = truncated)
}

.interactive_viewer_value <- function(value) {
  if (dataview_is_table(value)) {
    snapshot <- .interactive_table_snapshot(value)
    registration <- dataview_register(snapshot$value)
    metadata <- handle_dataview_init(list(view_id = registration$view_id))
    preview <- handle_dataview_page(list(
      view_id = registration$view_id,
      startRow = 0L,
      endRow = 20L,
      formatNumbers = TRUE,
      sortModel = list(),
      filterModel = list()
    ))
    printed <- .interactive_table_text(snapshot$value)
    full_view <- NULL
    if (snapshot$truncated) {
      # Retain the full object without copying it. The cell remains a snapshot;
      # the expanded viewer can reflect later reference edits to this object.
      full_view <- dataview_register(value, live = TRUE)$view_id
      if (!is.null(printed$printedText)) {
        note <- sprintf(
          "\n[Snapshot: first %s of %s rows. Open Data viewer for the full table.]\n",
          format(metadata$totalRows, big.mark = ",", scientific = FALSE, trim = TRUE),
          format(snapshot$source_rows, big.mark = ",", scientific = FALSE, trim = TRUE)
        )
        printed$printedText <- paste0(printed$printedText, note)
      }
    }
    .interactive_event(
      "display",
      c(
        list(
          kind = "table",
          viewId = registration$view_id,
          fullViewId = full_view,
          sourceRows = snapshot$source_rows,
          columns = metadata$columns,
          rows = preview$rows,
          formattedColumns = preview$formattedColumns,
          totalRows = metadata$totalRows
        ),
        printed
      )
    )
    return(TRUE)
  }
  if (is.list(value) && !is.object(value)) {
    view_id <- dataview_new_id()
    # Nested panels reuse the root's owner; separate cell results must stay independent.
    root <- listview_state(value, "List", paste0("interactive:", view_id))
    dataview_set_state(view_id, root)
    preview <- get_workspace_children(view_id = view_id)
    .interactive_event(
      "display",
      c(
        list(
          kind = "list",
          viewId = view_id,
          navigation = listview_navigation(listview_location(root))
        ),
        preview,
        .interactive_table_text(value)
      )
    )
    return(TRUE)
  }
  FALSE
}

show_dataview <- function(x, title = deparse(substitute(x))) {
  # Capture the root before forcing x so View(x$a) shares the viewer for x.
  original_expression <- substitute(x)
  expression <- original_expression
  while (
    is.call(expression) &&
      is.symbol(expression[[1L]]) &&
      as.character(expression[[1L]]) %in% c("$", "[[", "@")
  ) {
    expression <- expression[[2L]]
  }
  owner <- .sess_env$view_owner
  if (is.null(owner) && missing(title) && is.symbol(expression)) {
    owner <- as.character(expression)
  }
  force(title)

  if (
    is.null(.sess_env$view_owner) &&
      isTRUE(.sess_env$interactive_connected) &&
      .interactive_rich_value(x)
  ) {
    return(invisible(NULL))
  }

  view_type <- if (dataview_is_table(x)) {
    "table"
  } else if (listview_supported(x)) {
    "list"
  } else {
    "object"
  }
  title_key <- paste(as.character(title), collapse = "\n")
  owner <- owner %||% title_key
  registry_key <- paste0(view_type, ":", owner)
  dataview_registry <- .sess_env$dataview_registry
  view_id <- if (
    nzchar(title_key) && exists(registry_key, envir = dataview_registry, inherits = FALSE)
  ) {
    get(registry_key, envir = dataview_registry, inherits = FALSE)
  } else {
    id <- dataview_new_id()
    if (nzchar(title_key)) {
      assign(registry_key, id, envir = dataview_registry)
    }
    id
  }

  if (view_type == "table") {
    registration <- dataview_register(x, view_id = view_id)

    notify_client(
      "dataview",
      list(
        title = title,
        source = "table",
        type = "json",
        view_id = registration$view_id,
        state_generation = registration$state_generation
      )
    )
  } else if (view_type == "list") {
    context <- .sess_env$listview_context
    if (is.null(context) && missing(title)) {
      context <- listview_expression_context(original_expression, parent.frame(), owner, x)
    }
    root <- if (is.null(context)) listview_state(x, title_key, owner) else context$root
    navigation <- if (is.null(context)) {
      listview_navigation(listview_location(root))
    } else {
      context$navigation
    }
    root <- dataview_set_state(view_id, root)
    notify_client(
      "dataview",
      list(
        title = title,
        source = view_type,
        type = "json",
        view_id = view_id,
        state_generation = root$state_generation,
        navigation = navigation
      )
    )
  } else {
    code <- if (is.primitive(x)) utils::capture.output(print(x)) else deparse(x)
    file_path <- .sess_env$dataviews[[view_id]]$file %||%
      tempfile(tmpdir = .sess_env$tempdir, fileext = ".R")
    writeLines(code, file_path)
    .sess_env$dataviews[[view_id]] <- list(type = "object", file = file_path)
    notify_client(
      "dataview",
      list(title = title, file = file_path, source = "object", type = "R")
    )
  }
}
