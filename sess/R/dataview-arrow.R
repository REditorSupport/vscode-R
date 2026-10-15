# Arrow IPC conversion used by the database result cache.

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
