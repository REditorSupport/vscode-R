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

  # Use the device built into the current CI platform. Explicit cairo on macOS
  # can require X11 libraries that are not part of the runner image.
  png_type <- switch(Sys.info()[["sysname"]],
    Windows = "windows",
    Darwin = if (isTRUE(capabilities("aqua"))) {
      "quartz"
    } else if (isTRUE(capabilities("cairo"))) {
      "cairo"
    } else {
      NULL
    },
    Linux = if (isTRUE(capabilities("cairo"))) "cairo" else NULL,
    NULL
  )
  expect_true(!is.null(png_type), info = "R should provide a headless PNG device on CI")
  png_dev_args <- if (is.null(png_type)) list() else list(type = png_type)

  expect_png <- function(result, label) {
    data <- result$data
    valid_data <- is.character(data) && length(data) == 1L && !is.na(data)
    expect_true(valid_data, info = paste(label, "renderer should return base64 data"))
    if (!valid_data) {
      return(invisible(NULL))
    }

    bytes <- tryCatch(
      jsonlite::base64_dec(charToRaw(data)),
      error = function(e) raw()
    )
    expect_true(length(bytes) > 8L, info = paste(label, "renderer should return a PNG image"))
    if (length(bytes) >= 8L) {
      expect_equal(
        as.integer(bytes[1:8]),
        c(137L, 80L, 78L, 71L, 13L, 10L, 26L, 10L),
        info = paste(label, "renderer should return the PNG signature")
      )
    }
    invisible(NULL)
  }

  png_result <- sess:::handle_plot_latest(list(
    width = 640, height = 480, format = "png", devArgs = png_dev_args
  ))
  expect_equal(png_result$format, "png")
  expect_png(png_result, "PNG")

  if (requireNamespace("svglite", quietly = TRUE)) {
    svg_result <- sess:::handle_plot_latest(list(
      width = 640, height = 480, format = "svglite"
    ))
    expect_equal(svg_result$format, "svglite")
    valid_svg_data <- is.character(svg_result$data) && length(svg_result$data) == 1L && !is.na(svg_result$data)
    expect_true(valid_svg_data, info = "SVG renderer should return base64 data")
    if (valid_svg_data) {
      svg_bytes <- tryCatch(
        jsonlite::base64_dec(charToRaw(svg_result$data)),
        error = function(e) raw()
      )
      svg_text <- if (length(svg_bytes)) rawToChar(svg_bytes) else ""
      expect_true(grepl("<svg", svg_text, fixed = TRUE), info = "SVG output should contain an SVG root")
    }
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
    width = 640, height = 480, format = "svglite", devArgs = png_dev_args
  ))
  expect_equal(fallback_result$format, "png")
  expect_png(fallback_result, "svglite fallback")

  sess_env$latest_plot_record <- NULL
  absent_result <- sess:::handle_plot_latest(list(format = "png"))
  expect_null(absent_result$data)
})
