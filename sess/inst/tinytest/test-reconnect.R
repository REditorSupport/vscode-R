# Exercise delayed retries without waiting for wall-clock timers.
local({
  env <- new.env(parent = asNamespace("sess"))
  env$.sess_env <- new.env(parent = emptyenv())
  env$.sess_env$transport_generation <- 1L
  env$.schedule_reconnect <- sess:::.schedule_reconnect
  environment(env$.schedule_reconnect) <- env
  env$.transport_disconnect <- function(silent) {
    env$.sess_env$con <- NULL
    env$.sess_env$transport_generation <- env$.sess_env$transport_generation + 1L
  }
  callbacks <- list()
  schedule <- function(callback, delay) {
    expect_equal(delay, 1)
    callbacks[[length(callbacks) + 1L]] <<- callback
  }
  tick <- function() {
    callback <- callbacks[[1L]]
    callbacks <<- callbacks[-1L]
    callback()
  }
  attempts <- list()
  succeed <- FALSE
  env$connect <- function(...) {
    attempts[[length(attempts) + 1L]] <<- list(...)
    env$.sess_env$transport_generation <- env$.sess_env$transport_generation + 1L
    if (succeed) env$.sess_env$con <- "new connection"
  }
  path <- tempfile()
  on.exit(unlink(path))
  settings <- list(path = path, endpoint = "old", options = list(
    use_rstudioapi = FALSE, use_httpgd = TRUE, use_jgd = FALSE
  ))
  env$.schedule_reconnect(settings, schedule = schedule)
  tick() # Missing discovery file.
  writeLines('{', path)
  tick() # Partially written discovery file.
  writeLines('{"version":2,"endpoint":"new"}', path)
  tick() # Unsupported discovery schema.
  writeLines('{"version":1,"endpoint":"old"}', path)
  tick() # Still the dead endpoint.
  expect_equal(length(attempts), 0L)
  expect_equal(length(callbacks), 1L)
  writeLines('{"version":1,"endpoint":"new"}', path)
  tick() # New server not ready yet.
  expect_equal(length(attempts), 1L)
  succeed <- TRUE
  tick() # Retry the same replacement endpoint.
  expect_equal(length(attempts), 2L)
  expect_equal(attempts[[2L]], c(list(endpoint = "new"), settings$options))
  expect_equal(env$.sess_env$reconnect$endpoint, "new")
  expect_equal(length(callbacks), 0L)

  env$.sess_env$con <- NULL
  env$.schedule_reconnect(settings, schedule = schedule)
  env$.sess_env$transport_generation <- env$.sess_env$transport_generation + 1L
  tick() # A manual connect/disconnect invalidates the pending retry.
  expect_equal(length(attempts), 2L)
  expect_equal(length(callbacks), 0L)

  env$.schedule_reconnect(settings, schedule = schedule)
  env$.sess_env$con <- "manual connection"
  tick()
  expect_equal(length(attempts), 2L)
  expect_equal(env$.sess_env$con, "manual connection")
  expect_equal(length(callbacks), 0L)
})
