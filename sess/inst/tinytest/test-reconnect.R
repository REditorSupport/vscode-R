# Exercise delayed retries without waiting for wall-clock timers.
local({
  env <- new.env(parent = asNamespace("sess"))
  env$.sess_env <- new.env(parent = emptyenv())
  env$.sess_env$transport_generation <- 1L
  env$.schedule_reconnect <- sess:::.schedule_reconnect
  environment(env$.schedule_reconnect) <- env
  env$.reconnect_with_startup <- sess:::.reconnect_with_startup
  environment(env$.reconnect_with_startup) <- env
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
  original_jgd <- Sys.getenv("JGD_SOCKET", unset = NA_character_)
  on.exit({
    if (is.na(original_jgd)) Sys.unsetenv("JGD_SOCKET") else
      Sys.setenv(JGD_SOCKET = original_jgd)
  }, add = TRUE)
  seen_jgd <- character()
  attempts <- list()
  succeed <- FALSE
  env$connect <- function(...) {
    seen_jgd <<- c(seen_jgd, Sys.getenv("JGD_SOCKET", unset = "<unset>"))
    attempts[[length(attempts) + 1L]] <<- list(...)
    env$.sess_env$transport_generation <- env$.sess_env$transport_generation + 1L
    if (succeed) {
      env$.sess_env$con <- "new connection"
      TRUE
    } else {
      FALSE
    }
  }
  path <- tempfile()
  on.exit(unlink(path), add = TRUE)
  settings <- list(path = path, endpoint = "old", options = list(
    use_rstudioapi = FALSE, plot_backend = "httpgd"
  ))
  env$.schedule_reconnect(settings, schedule = schedule)
  tick() # Missing discovery file.
  writeLines("{", path)
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

  # Renderer metadata must be installed before connect starts the runtime.
  settings$options$plot_backend <- "jgd"
  for (socket in c("replacement-jgd", "")) {
    env$.sess_env$con <- NULL
    Sys.setenv(JGD_SOCKET = "dead-jgd")
    writeLines(jsonlite::toJSON(list(version = 1L, endpoint = "new", jgdSocket = socket),
                                auto_unbox = TRUE), path)
    env$.schedule_reconnect(settings, schedule = schedule)
    tick()
    expect_equal(tail(seen_jgd, 1L), if (nzchar(socket)) socket else "<unset>")
    expect_equal(length(callbacks), 0L)
  }

  # Clients publishing only the core discovery contract do not manage JGD.
  env$.sess_env$con <- NULL
  Sys.setenv(JGD_SOCKET = "external-jgd")
  writeLines('{"version":1,"endpoint":"new"}', path)
  env$.schedule_reconnect(settings, schedule = schedule)
  tick()
  expect_equal(tail(seen_jgd, 1L), "external-jgd")

  # Invalid metadata, unchanged endpoints, and stale callbacks cannot mutate JGD.
  env$.sess_env$con <- NULL
  writeLines('{"version":1,"endpoint":"new","jgdSocket":123}', path)
  env$.schedule_reconnect(settings, schedule = schedule)
  count <- length(attempts)
  tick()
  expect_equal(length(attempts), count)
  expect_equal(Sys.getenv("JGD_SOCKET"), "external-jgd")
  writeLines('{"version":1,"endpoint":"old","jgdSocket":"unused"}', path)
  tick()
  expect_equal(Sys.getenv("JGD_SOCKET"), "external-jgd")
  writeLines('{"version":1,"endpoint":"new","jgdSocket":"unused"}', path)
  env$.sess_env$transport_generation <- env$.sess_env$transport_generation + 1L
  tick()
  expect_equal(Sys.getenv("JGD_SOCKET"), "external-jgd")
  expect_equal(length(attempts), count)
  expect_equal(length(callbacks), 0L)

  # An explicit native backend must survive the same reconnect path.
  native_options <- list(use_rstudioapi = FALSE, plot_backend = "native")
  native_settings <- list(path = path, endpoint = "old", options = native_options)
  env$.sess_env$con <- NULL
  Sys.setenv(JGD_SOCKET = "external-jgd")
  writeLines('{"version":1,"endpoint":"new","jgdSocket":"unused"}', path)
  env$.schedule_reconnect(native_settings, schedule = schedule)
  tick()
  expect_equal(tail(attempts, 1L)[[1L]],
               c(list(endpoint = "new"), native_options))
  expect_equal(Sys.getenv("JGD_SOCKET"), "external-jgd")
  expect_equal(length(callbacks), 0L)

  # A registered notifier receives the replacement endpoint and owns the
  # setup callback. A same-process registration without a notifier fails closed.
  startup_option <- "vscodeR.terminalStartup"
  original_startup <- getOption(startup_option)
  on.exit(options(structure(list(original_startup), names = startup_option)), add = TRUE)
  notified_endpoint <- character()
  registration <- list(
    pid = Sys.getpid(),
    run = function(endpoint, setup) {
      notified_endpoint <<- c(notified_endpoint, endpoint)
      setup()
    }
  )
  options(structure(list(registration), names = startup_option))
  env$.sess_env$con <- NULL
  succeed <- TRUE
  env$.schedule_reconnect(native_settings, schedule = schedule)
  tick()
  expect_equal(notified_endpoint, "new")
  expect_equal(tail(attempts, 1L)[[1L]], c(list(endpoint = "new"), native_options))
  expect_equal(length(callbacks), 0L)

  registration$run <- NULL
  options(structure(list(registration), names = startup_option))
  env$.sess_env$con <- NULL
  attempts_before <- length(attempts)
  env$.schedule_reconnect(native_settings, schedule = schedule)
  tick() # A same-process registration without its notifier must not connect.
  expect_equal(length(attempts), attempts_before)
  expect_equal(length(callbacks), 1L)
  env$.sess_env$transport_generation <- env$.sess_env$transport_generation + 1L
  tick() # Invalidate the retry without invoking setup.
  expect_equal(length(callbacks), 0L)

})
