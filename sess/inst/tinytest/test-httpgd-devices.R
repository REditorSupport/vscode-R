if (requireNamespace("httpgd", quietly = TRUE) &&
    packageVersion("httpgd") >= "2.0.1") local({
  original_device <- grDevices::dev.cur()
  original_devices <- grDevices::dev.list()
  original_hgd <- httpgd::hgd
  sess_env <- sess:::.sess_env
  cons <- processx::conn_create_pipepair()
  previous_connection <- sess_env$con
  sess_env$con <- cons[[2L]]
  notifications <- function() {
    lines <- strsplit(processx::conn_read_chars(cons[[1L]]), "\n", fixed = TRUE)[[1L]]
    lapply(lines, jsonlite::fromJSON)
  }
  on.exit({
    sess:::runtime_stop()
    sess_env$con <- previous_connection
    close(cons[[1L]])
    close(cons[[2L]])
    for (id in rev(setdiff(grDevices::dev.list(), original_devices))) {
      try(grDevices::dev.off(id), silent = TRUE)
    }
    if (original_device %in% grDevices::dev.list()) grDevices::dev.set(original_device)
  }, add = TRUE)
  sess:::runtime_start(use_rstudioapi = FALSE, plot_backend = "httpgd")
  # Direct calls and dev.new() both register through the same integration.
  httpgd::hgd(silent = TRUE)
  graphics::plot(1:10, main = "FIRST DEVICE")
  first <- grDevices::dev.cur()
  grDevices::dev.new()
  graphics::plot(1:100, main = "SECOND DEVICE")
  second <- grDevices::dev.cur()
  registered <- notifications()
  expect_equal(vapply(registered, `[[`, character(1), "method"), c("httpgd", "httpgd"))
  expect_equal(vapply(registered, function(item) item$params$url, character(1)),
               c(httpgd::hgd_url(which = first), httpgd::hgd_url(which = second)))
  expect_length(sess:::.runtime_state()$devices, 1L)
  expect_identical(sess:::.runtime_state()$devices[[1L]]$id, unname(second))
  sess:::runtime_stop(preserve_plots = TRUE)
  expect_identical(httpgd::hgd, original_hgd)
  sess:::runtime_start(use_rstudioapi = FALSE, plot_backend = "httpgd")
  restored <- notifications()
  expect_length(restored, 2L)
  expect_true(all(vapply(restored, function(item) isTRUE(item$params$restoring), logical(1))))
  expect_length(sess:::.runtime_state()$devices, 1L)
  sess:::runtime_stop()
  expect_true(first %in% grDevices::dev.list())
  expect_false(second %in% grDevices::dev.list())
  expect_identical(httpgd::hgd, original_hgd)

  # Replacing a closed factory device with an explicit hgd() must not inherit
  # the old registration's cleanup ownership merely by reusing its number.
  sess:::runtime_start(use_rstudioapi = FALSE, plot_backend = "httpgd")
  grDevices::dev.new()
  factory <- grDevices::dev.cur()
  grDevices::dev.off(factory)
  httpgd::hgd(silent = TRUE)
  replacement <- grDevices::dev.cur()
  expect_identical(replacement, factory)
  expect_length(sess:::.runtime_state()$devices, 0L)
  sess:::runtime_stop()
  expect_true(replacement %in% grDevices::dev.list())
  expect_true(first %in% grDevices::dev.list())
})

if (requireNamespace("httpgd", quietly = TRUE) &&
    packageVersion("httpgd") >= "2.0.1") local({
  # A restored-device notification can fail after attach succeeds. No runtime
  # hooks or bindings may be installed after that failure cleans up the runtime.
  has_rstudioapi <- requireNamespace("rstudioapi", quietly = TRUE)
  original_available <- if (has_rstudioapi) rstudioapi::isAvailable else NULL
  original_hook <- getHook(packageEvent("rstudioapi", "onLoad"))
  original_callbacks <- getTaskCallbackNames()
  original_device <- getOption("device")
  original_hgd <- httpgd::hgd
  sess_env <- sess:::.sess_env
  previous_connection <- sess_env$con
  httpgd::hgd(silent = TRUE)
  device <- grDevices::dev.cur()
  cons <- processx::conn_create_pipepair()
  close(cons[[1L]])
  sess_env$con <- cons[[2L]]
  on.exit({
    sess:::runtime_stop()
    sess_env$con <- previous_connection
    try(close(cons[[2L]]), silent = TRUE)
    if (device %in% grDevices::dev.list()) grDevices::dev.off(device)
  }, add = TRUE)

  suppressWarnings(sess:::runtime_start(use_rstudioapi = TRUE, plot_backend = "httpgd"))
  expect_null(sess_env$con)
  state <- sess:::.runtime_state()
  expect_false(isTRUE(state$active))
  for (field in c("hooks", "bindings", "task_callbacks", "options", "s3_methods")) {
    expect_length(state[[field]], 0L)
  }
  expect_identical(getTaskCallbackNames(), original_callbacks)
  expect_identical(getHook(packageEvent("rstudioapi", "onLoad")), original_hook)
  expect_identical(getOption("device"), original_device)
  expect_identical(httpgd::hgd, original_hgd)
  if (has_rstudioapi) expect_identical(rstudioapi::isAvailable, original_available)
  expect_true(device %in% grDevices::dev.list())
})
