# Printed snapshots retain class dispatch, whitespace and current R options.
printed <- sess:::.interactive_table_text
value <- data.frame(x = c(pi, NA_real_), y = c("λ", "a b"))
local({
  old <- options(digits = 4, width = 50)
  on.exit(options(old))
  expected <- paste0(paste(capture.output(print(value)), collapse = "\n"), "\n")
  expect_identical(printed(value)$printedText, expected)
})

# Failed user printers must not break the rich preview or leave a sink active.
local({
  print.snapshot_failure <- function(x, ...) stop("custom print failed")
  assign("print.snapshot_failure", print.snapshot_failure, envir = .GlobalEnv)
  on.exit(rm("print.snapshot_failure", envir = .GlobalEnv))
  before <- sink.number()
  result <- printed(structure(value, class = c("snapshot_failure", "data.frame")))
  expect_identical(result$printError, "custom print failed")
  expect_identical(sink.number(), before)
  expect_true(nzchar(printed(value)$printedText))
})

# Bound retained text and keep UTF-8 valid even when the cutoff splits a glyph.
local({
  print.snapshot_large <- function(x, ...) cat(strrep("λ🙂", 50000L))
  assign("print.snapshot_large", print.snapshot_large, envir = .GlobalEnv)
  on.exit(rm("print.snapshot_large", envir = .GlobalEnv))
  result <- printed(structure(value, class = c("snapshot_large", "data.frame")))$printedText
  expect_true(nchar(result, type = "bytes") < 263000L)
  expect_true(validUTF8(result))
  expect_true(grepl("Printed preview truncated", result, fixed = TRUE))
})

# A deliberately silent class printer produces a valid empty text snapshot.
local({
  print.snapshot_empty <- function(x, ...) invisible(x)
  assign("print.snapshot_empty", print.snapshot_empty, envir = .GlobalEnv)
  on.exit(rm("print.snapshot_empty", envir = .GlobalEnv))
  expect_identical(printed(structure(value, class = c("snapshot_empty", "data.frame")))$printedText,
                   "")
})
