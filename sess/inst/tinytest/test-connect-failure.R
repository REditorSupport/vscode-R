# Runtime startup is part of connection success, including automatic retries.
local({
  env <- new.env(parent = asNamespace("sess"))
  for (name in c("connect", "runtime_start", ".schedule_reconnect")) {
    fun <- get(name, asNamespace("sess"))
    environment(fun) <- env
    assign(name, fun, env)
  }
  fail <- TRUE
  env$.runtime_add_task_callback <- function(fun, name) {
    sess:::.runtime_add_task_callback(fun, name)
    if (fail && identical(name, "sess.workspace")) stop("injected runtime failure")
  }
  endpoint <- if (.Platform$OS.type == "windows") {
    paste0("\\\\?\\pipe\\", basename(tempfile("sess-startup-")))
  } else {
    tempfile(fileext = ".sock")
  }
  discovery <- tempfile(fileext = ".json")
  writeLines(jsonlite::toJSON(list(version = 1L, endpoint = endpoint),
                              auto_unbox = TRUE), discovery)
  original_discovery <- Sys.getenv("SESS_DISCOVERY_FILE", unset = NA_character_)
  Sys.setenv(SESS_DISCOVERY_FILE = discovery)
  original_view <- utils::View
  original_options <- options()[c("browser", "viewer", "device")]
  original_callbacks <- getTaskCallbackNames()
  original_plot_hook <- getHook("plot.new")
  server <- NULL
  on.exit({
    sess:::.transport_disconnect(silent = TRUE)
    if (!is.null(server)) try(close(server), silent = TRUE)
    unlink(c(discovery, if (.Platform$OS.type != "windows") endpoint))
    if (is.na(original_discovery)) Sys.unsetenv("SESS_DISCOVERY_FILE") else
      Sys.setenv(SESS_DISCOVERY_FILE = original_discovery)
  }, add = TRUE)

  listen <- function() {
    server <<- processx::conn_create_unix_socket(endpoint, encoding = "")
  }
  # Accept while the client is open, including on Windows named pipes. Drive
  # subsequent retries explicitly instead of starting background poll timers.
  env$poll_connection <- function(...) {
    processx::poll(list(server), 1000L)
    processx::conn_accept_unix_socket(server)
    processx::poll(list(server), 1000L)
    line <- processx::conn_read_chars(server)
    expect_equal(jsonlite::fromJSON(trimws(line))$method, "attach")
  }
  close_peer <- function() {
    close(server)
    server <<- NULL
    if (.Platform$OS.type != "windows") unlink(endpoint)
  }
  expect_clean <- function() {
    expect_null(sess:::.sess_env$con)
    state <- sess:::.runtime_state()
    expect_false(isTRUE(state$active))
    for (field in c("hooks", "bindings", "task_callbacks", "options", "s3_methods")) {
      expect_equal(length(state[[field]]), 0L)
    }
    expect_identical(utils::View, original_view)
    expect_identical(options()[names(original_options)], original_options)
    expect_identical(getTaskCallbackNames(), original_callbacks)
    expect_identical(getHook("plot.new"), original_plot_hook)
  }
  opts <- list(use_rstudioapi = FALSE, use_httpgd = FALSE, use_jgd = FALSE)
  listen()
  expect_error(do.call(env$connect, c(list(endpoint = endpoint), opts)),
               "injected runtime failure")
  close_peer() # Transport connected and sent attach before runtime failed.
  expect_clean()

  callbacks <- list()
  schedule <- function(callback, delay) {
    callbacks[[length(callbacks) + 1L]] <<- callback
  }
  tick <- function() {
    callback <- callbacks[[1L]]
    callbacks <<- callbacks[-1L]
    callback()
  }
  settings <- list(path = discovery, endpoint = "old", options = opts)
  env$.schedule_reconnect(settings, schedule = schedule)
  listen()
  tick()
  close_peer()
  expect_clean()
  expect_equal(length(callbacks), 1L)

  fail <- FALSE
  listen()
  tick()
  expect_false(is.null(sess:::.sess_env$con))
  expect_true(isTRUE(sess:::.runtime_state()$active))
  expect_equal(length(callbacks), 0L)
  expect_equal(sum(getTaskCallbackNames() == "sess.workspace"), 1L)
})
