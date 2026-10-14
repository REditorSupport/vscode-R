# Only automatic reconnects redraw the prompt, and sess.quiet suppresses only success.
local({
  if (!requireNamespace("processx", quietly = TRUE) || .Platform$OS.type == "windows") {
    return(invisible(NULL))
  }

  old_options <- options()[c("sess.quiet", "prompt")]
  on.exit({
    options(old_options)
    sess:::.transport_disconnect(silent = TRUE)
  }, add = TRUE)

  # Tests run non-interactively, so present an interactive console to connect().
  # .schedule_reconnect() is rebound too so that its retries call this copy.
  env <- new.env(parent = asNamespace("sess"))
  for (name in c("connect", ".schedule_reconnect")) {
    fun <- get(name, asNamespace("sess"))
    environment(fun) <- env
    assign(name, fun, env)
  }
  env$interactive <- function() TRUE
  opts <- list(use_rstudioapi = FALSE, plot_backend = "standard")

  connect_once <- function(quiet) {
    path <- tempfile(fileext = ".sock")
    server <- processx::conn_create_unix_socket(path, encoding = "")
    on.exit({
      sess:::.transport_disconnect(silent = TRUE)
      try(close(server), silent = TRUE)
      unlink(path)
    }, add = TRUE)

    options(sess.quiet = quiet)
    capture.output(do.call(env$connect, c(list(endpoint = path), opts)))
  }

  options(prompt = "custom prompt> ")
  visible <- connect_once(FALSE)
  expect_true(any(grepl("\\[sess\\] Connected to VS Code", visible)))
  expect_false(any(grepl("custom prompt>", visible, fixed = TRUE)))

  quiet <- connect_once(TRUE)
  expect_length(quiet, 0L)

  missing <- tempfile(fileext = ".sock")
  failure <- capture.output(do.call(env$connect, c(list(endpoint = missing), opts)))
  expect_true(any(grepl("\\[sess\\] Failed to connect", failure)))
  expect_false(any(grepl("custom prompt>", failure, fixed = TRUE)))

  # Automatic reconnects print at an idle prompt, so each message redraws it.
  callbacks <- list()
  schedule <- function(callback, delay) {
    callbacks[[length(callbacks) + 1L]] <<- callback
  }
  tick <- function() {
    callback <- callbacks[[1L]]
    callbacks <<- callbacks[-1L]
    capture.output(callback())
  }
  replacement <- tempfile(fileext = ".sock")
  discovery <- tempfile(fileext = ".json")
  writeLines(jsonlite::toJSON(list(version = 1L, endpoint = replacement),
                              auto_unbox = TRUE), discovery)
  server <- NULL
  on.exit({
    if (!is.null(server)) try(close(server), silent = TRUE)
    unlink(c(replacement, discovery))
  }, add = TRUE)

  options(sess.quiet = FALSE)
  env$.schedule_reconnect(list(path = discovery, endpoint = "old", options = opts),
                          schedule = schedule)
  not_listening <- tick()
  expect_true(any(grepl("\\[sess\\] Failed to connect", not_listening)))
  expect_equal(tail(not_listening, 1L), "custom prompt> ")

  server <- processx::conn_create_unix_socket(replacement, encoding = "")
  reconnected <- tick()
  expect_true(any(grepl("\\[sess\\] Connected to VS Code", reconnected)))
  expect_equal(tail(reconnected, 1L), "custom prompt> ")

  # Once the reconnect finishes, a manual connect returns to a fresh prompt again.
  expect_false(any(grepl("custom prompt>", connect_once(FALSE), fixed = TRUE)))
})
