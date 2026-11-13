# R reuses graphics device numbers after dev.off(). A new registration must
# replace the previous lifetime without removing other live device identities.
local({
  original_devices <- grDevices::dev.list()
  on.exit({
    for (id in rev(setdiff(grDevices::dev.list(), original_devices))) {
      try(grDevices::dev.off(id), silent = TRUE)
    }
  }, add = TRUE)

  state <- new.env(parent = emptyenv())
  state$devices <- list()
  env <- new.env(parent = asNamespace("sess"))
  env$.runtime_state <- function() state
  track <- sess:::.runtime_track_device
  environment(track) <- env

  grDevices::pdf(NULL)
  track()
  state$devices[[1L]]$key <- "other-live-device"
  other <- state$devices[[1L]]

  grDevices::pdf(NULL)
  id <- grDevices::dev.cur()
  track()
  state$devices[[2L]]$key <- "closed-device"
  grDevices::dev.off(id)
  grDevices::pdf(NULL)
  expect_identical(grDevices::dev.cur(), id)
  track()

  expect_length(state$devices, 2L)
  expect_identical(state$devices[[1L]], other)
  expect_identical(state$devices[[2L]]$id, unname(id))
  expect_null(state$devices[[2L]]$key)
})

# Device numbers and names do not establish ownership across a disconnect.
# Use a saved closer too: lifetime checks must not depend on wrapping dev.off().
for (reconnect in c(FALSE, TRUE)) local({
  close_device <- grDevices::dev.off
  sess_env <- sess:::.sess_env
  previous_connection <- sess_env$con
  previous_plot_path <- sess_env$latest_plot_path
  sess_env$latest_plot_path <- tempfile(fileext = ".png")
  cons <- processx::conn_create_pipepair()
  sess_env$con <- cons[[2L]]
  caller_file <- tempfile(fileext = ".pdf")
  caller <- NULL
  on.exit({
    sess:::runtime_stop()
    if (!is.null(caller) && caller %in% grDevices::dev.list()) close_device(caller)
    sess_env$con <- previous_connection
    unlink(sess_env$latest_plot_path)
    sess_env$latest_plot_path <- previous_plot_path
    close(cons[[1L]])
    close(cons[[2L]])
    unlink(caller_file)
  }, add = TRUE)

  sess:::runtime_start(use_rstudioapi = FALSE, plot_backend = "standard")
  getOption("device")()
  owned <- grDevices::dev.cur()
  graphics::plot(1:3, main = "owned standard plot")
  owned_record <- grDevices::recordPlot()
  sess:::runtime_stop(preserve_plots = TRUE)
  sess:::runtime_start(use_rstudioapi = FALSE, plot_backend = "standard")
  expect_identical(sess_env$latest_plot_record, owned_record)
  if (reconnect) sess:::runtime_stop(preserve_plots = TRUE)

  close_device(owned)
  grDevices::pdf(caller_file)
  caller <- grDevices::dev.cur()
  expect_identical(caller, owned)
  grDevices::dev.control(displaylist = "enable")
  graphics::plot(3:1, main = "caller-owned PDF")
  if (reconnect) {
    sess:::runtime_start(use_rstudioapi = FALSE, plot_backend = "standard")
    expect_length(sess:::.runtime_state()$devices, 0L)
    expect_identical(sess_env$latest_plot_record, owned_record)
  }
  sess:::runtime_stop()
  expect_true(caller %in% grDevices::dev.list())
})
