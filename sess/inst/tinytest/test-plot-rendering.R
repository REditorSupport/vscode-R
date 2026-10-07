# Verify the recorded-plot renderer independently of the VS Code viewer.
local({
  sess_env <- sess:::.sess_env
  old_record <- sess_env$latest_plot_record
  old_tempdir <- sess_env$tempdir
  open_devices <- grDevices::dev.list()
  source_plot_file <- tempfile(fileext = ".pdf")
  sess_env$tempdir <- tempdir()

  on.exit({
    current_devices <- grDevices::dev.list()
    if (!is.null(current_devices)) {
      extra_devices <- setdiff(current_devices, open_devices)
      for (device in rev(extra_devices)) {
        try(grDevices::dev.off(device), silent = TRUE)
      }
    }
    sess_env$latest_plot_record <- old_record
    sess_env$tempdir <- old_tempdir
    unlink(source_plot_file)
  }, add = TRUE)

  grDevices::pdf(source_plot_file)
  grDevices::dev.control(displaylist = "enable")
  graphics::plot(c(1, 3, 2), main = "recorded plot renderer test")
  sess_env$latest_plot_record <- grDevices::recordPlot()
  expect_inherits(sess_env$latest_plot_record, "recordedplot")

  png_result <- sess:::handle_plot_latest(list(
    width = 640, height = 480, format = "png", devArgs = list(type = "cairo")
  ))
  expect_equal(png_result$format, "png")
  expect_true(is.character(png_result$data) && length(png_result$data) == 1L)
  png_bytes <- jsonlite::base64_dec(charToRaw(png_result$data))
  expect_true(length(png_bytes) > 8L)
  expect_equal(as.integer(png_bytes[1:8]), c(137L, 80L, 78L, 71L, 13L, 10L, 26L, 10L))

  if (requireNamespace("svglite", quietly = TRUE)) {
    svg_result <- sess:::handle_plot_latest(list(
      width = 640, height = 480, format = "svglite"
    ))
    expect_equal(svg_result$format, "svglite")
    expect_true(is.character(svg_result$data) && length(svg_result$data) == 1L)
    svg_text <- rawToChar(jsonlite::base64_dec(charToRaw(svg_result$data)))
    expect_true(grepl("<svg", svg_text, fixed = TRUE))
  }

  # Resolve the optional dependency check through a local handler environment so
  # this fallback remains deterministic even on CI images with svglite installed.
  fallback_env <- new.env(parent = asNamespace("sess"))
  fallback_env$.sess_env <- sess_env
  fallback_env$requireNamespace <- function(package, quietly = FALSE, ...) {
    if (identical(package, "svglite")) {
      FALSE
    } else {
      base::requireNamespace(package, quietly = quietly, ...)
    }
  }
  fallback_handler <- sess:::handle_plot_latest
  environment(fallback_handler) <- fallback_env
  fallback_result <- fallback_handler(list(
    width = 640, height = 480, format = "svglite", devArgs = list(type = "cairo")
  ))
  expect_equal(fallback_result$format, "png")
  fallback_bytes <- jsonlite::base64_dec(charToRaw(fallback_result$data))
  expect_equal(as.integer(fallback_bytes[1:8]), c(137L, 80L, 78L, 71L, 13L, 10L, 26L, 10L))

  sess_env$latest_plot_record <- NULL
  absent_result <- sess:::handle_plot_latest(list(format = "png"))
  expect_null(absent_result$data)
})
