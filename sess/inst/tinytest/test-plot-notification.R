# The standard plot task callback records immediately but sends only after it
# returns. Stale notifications must not reach a replacement transport.
local({
  cons <- processx::conn_create_pipepair()
  sess_env <- sess:::.sess_env
  old_con <- sess_env$con
  old_generation <- sess_env$transport_generation
  old_plot_path <- sess_env$latest_plot_path
  plot_path <- tempfile(fileext = ".png")
  on.exit({
    sess:::runtime_stop()
    sess_env$con <- old_con
    sess_env$transport_generation <- old_generation
    sess_env$latest_plot_path <- old_plot_path
    try(close(cons[[1L]]), silent = TRUE)
    try(close(cons[[2L]]), silent = TRUE)
    unlink(plot_path)
  }, add = TRUE)
  sess_env$con <- cons[[2L]]
  sess_env$transport_generation <- if (is.null(old_generation)) 1L else old_generation + 1L
  sess_env$latest_plot_path <- plot_path

  scheduled <- list()
  task_callbacks <- list()
  scheduler <- function(callback, delay) {
    expect_equal(delay, 0)
    scheduled[[length(scheduled) + 1L]] <<- callback
  }
  # Capture the actual plot callback installed by runtime_start, and control
  # only scheduling so the test does not depend on wall-clock timing.
  env <- new.env(parent = asNamespace("sess"))
  env$runtime_start <- sess:::runtime_start
  environment(env$runtime_start) <- env
  env$.runtime_add_task_callback <- function(fun, name) {
    task_callbacks[[name]] <<- fun
  }
  env$.defer_runtime_notification <- function(method) {
    sess:::.defer_runtime_notification(method, schedule = scheduler)
  }
  env$runtime_start(use_rstudioapi = FALSE, use_httpgd = FALSE, use_jgd = FALSE)

  graphics::plot(1)
  expect_true(task_callbacks[["sess.plot"]]())
  expect_inherits(sess_env$latest_plot_record, "recordedplot")
  expect_length(scheduled, 1L)
  expect_false(identical(processx::poll(list(cons[[1L]]), 0L)[[1L]], "ready"))
  scheduled[[1L]]()
  sent <- jsonlite::fromJSON(processx::conn_read_chars(cons[[1L]]))
  expect_equal(sent$method, "plot_updated")

  graphics::plot(2)
  expect_true(task_callbacks[["sess.plot"]]())
  expect_length(scheduled, 2L)
  sess_env$transport_generation <- sess_env$transport_generation + 1L
  scheduled[[2L]]()
  expect_false(identical(processx::poll(list(cons[[1L]]), 0L)[[1L]], "ready"))

  # A failed deferred write stops the runtime after the plot task has returned.
  graphics::plot(3)
  expect_true(task_callbacks[["sess.plot"]]())
  expect_length(scheduled, 3L)
  expect_true(isTRUE(sess:::.runtime_state()$active))
  close(sess_env$con)
  expect_warning(scheduled[[3L]](), "Failed to send IPC message")
  expect_null(sess_env$con)
  expect_false(isTRUE(sess:::.runtime_state()$active))
})
