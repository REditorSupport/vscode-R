# Run against a disposable installation of the current sess package:
# R_LIBS=/tmp/vscr-interactive-validation/library Rscript src/test/examples/large-table.R
# The dense data.table is ~351 MiB; the 833M-row case uses compact ALTREP columns.
stopifnot(requireNamespace("data.table"), requireNamespace("sess"), capabilities("profmem"))
measure <- function(label, work) {
  file <- tempfile()
  on.exit(unlink(file))
  gc()
  Rprofmem(file)
  elapsed <- system.time(result <- work())[["elapsed"]]
  Rprofmem(NULL)
  allocations <- suppressWarnings(as.numeric(sub(" .*", "", readLines(file))))
  if (startsWith(label, "Complete bounded preview")) {
    stopifnot(max(allocations, na.rm = TRUE) < 8 * 2^20)
  }
  cat(sprintf("%s: %.3f s; allocated %.3f MiB; largest allocation %.3f MiB\n",
              label, elapsed, sum(allocations, na.rm = TRUE) / 2^20,
              max(allocations, na.rm = TRUE) / 2^20))
  invisible(result)
}
preview <- function(value) {
  snapshot <- sess:::.interactive_table_snapshot(value)
  view <- sess:::dataview_register(snapshot$value)$view_id
  if (snapshot$truncated) sess:::dataview_register(value, live = TRUE)
  rows <- sess:::handle_dataview_page(list(view_id = view, startRow = 0L,
                                          endRow = 20L, formatNumbers = TRUE))
  text <- sess:::.interactive_table_text(snapshot$value)
  # Include wire encoding, not just the R-side row slice.
  jsonlite::toJSON(list(rows = rows, text = text), auto_unbox = TRUE, digits = NA)
}
invisible(preview(iris)) # Warm namespace loading and byte compilation before measurement.
env <- sess:::.sess_env
for (n in c(100000L, 2000000L)) {
  dt <- data.table::as.data.table(setNames(lapply(1:23, function(i) rep(as.numeric(i), n)),
                                          paste0("x", 1:23)))
  copied <- measure(sprintf("Old deep copy (%s x 23)", n), function() data.table::copy(dt))
  rm(copied)
  output <- measure(sprintf("Complete bounded preview (%s x 23)", n), function() preview(dt))
  stopifnot(nchar(output, type = "bytes") < 350000L)
  full <- sess:::dataview_register(dt, live = TRUE)$view_id
  page <- measure(sprintf("Full table last page (%s x 23)", n), function() {
    sess:::handle_dataview_page(list(view_id = full, startRow = n - 20L, endRow = n))
  })
  stopifnot(nrow(page$rows) == 20L)
  env$dataviews <- list()
  rm(dt)
}
n <- 832976871L
huge <- structure(rep(list(seq_len(n)), 23L), names = paste0("x", 1:23),
                  class = "data.frame", row.names = c(NA_integer_, -n))
output <- measure("Complete bounded preview (832976871 x 23, ALTREP)", function() preview(huge))
stopifnot(nchar(output, type = "bytes") < 350000L)
full <- sess:::dataview_register(huge, live = TRUE)$view_id
page <- measure("Full table last page (832976871 x 23, ALTREP)", function() {
  sess:::handle_dataview_page(list(view_id = full, startRow = n - 20L, endRow = n))
})
stopifnot(tail(page$rows[["23"]], 1L) == n)
