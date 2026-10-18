# View() uses jdv over a persistent connection to the viewer host when jdv is installed.
if (!requireNamespace("jdv", quietly = TRUE)) {
  exit_file("jdv is not installed")
}

local({
  ns <- asNamespace("sess")
  runtime <- sess:::.sess_env
  previous_con <- runtime$con
  previous_plot_path <- runtime$latest_plot_path
  previous_interactive_connected <- runtime$interactive_connected
  original_request_client <- ns$request_client
  pipe <- processx::conn_create_pipepair()
  host <- NULL
  on.exit({
    sess:::runtime_stop()
    jdv::jdv_disconnect()
    unlockBinding("request_client", ns)
    assign("request_client", original_request_client, envir = ns)
    lockBinding("request_client", ns)
    runtime$con <- previous_con
    runtime$latest_plot_path <- previous_plot_path
    runtime$interactive_connected <- previous_interactive_connected
    if (!is.null(host)) host$kill()
    lapply(pipe, close)
  }, add = TRUE)
  runtime$con <- pipe[[2L]]
  # The standard plot backend needs the path that connect() normally sets.
  if (is.null(runtime$latest_plot_path)) runtime$latest_plot_path <- tempfile(fileext = ".png")
  options(sess.dataviewer = NULL)
  sess:::runtime_start(use_rstudioapi = FALSE, plot_backend = "standard")

  # VS Code answers `jdv/address` with the address of its per-session listener.
  stub_address <- function(address) {
    unlockBinding("request_client", ns)
    assign("request_client", function(action, args = list()) {
      if (is.null(address)) stop("no jdv transport") else list(address = address)
    }, envir = ns)
    lockBinding("request_client", ns)
  }
  read_messages <- function() {
    messages <- strsplit(processx::conn_read_chars(pipe[[1L]]), "\n", fixed = TRUE)[[1L]]
    lapply(messages[nzchar(messages)], jsonlite::fromJSON, simplifyVector = FALSE)
  }
  used_sess_viewer <- function() {
    any(vapply(read_messages(), function(message) identical(message$method, "dataview"),
               logical(1L)))
  }

  sample <- data.frame(x = c(2, 1, NA), y = c("b", "a", "c"))

  # The opt-out keeps the sess data viewer.
  options(sess.dataviewer = "sess")
  stub_address("tcp://127.0.0.1:1")
  expect_false(sess:::.jdv_connect())
  utils::View(sample)
  expect_true(used_sess_viewer())
  options(sess.dataviewer = NULL)

  # Without a transport, or with an unreachable one, View() falls back and leaves jdv alone.
  stub_address(NULL)
  expect_false(sess:::.jdv_connect())
  stub_address("tcp://127.0.0.1:1")
  expect_false(sess:::.jdv_connect())
  expect_identical(jdv::jdv_connection()$state, "disconnected")
  expect_null(runtime$jdv_address)
  utils::View(sample)
  expect_true(used_sess_viewer())

  # An embedded session of another jdv user is never taken over.
  jdv::jdv_register(sample)
  expect_identical(jdv::jdv_connection()$state, "embedded")
  stub_address("tcp://127.0.0.1:1")
  expect_false(sess:::.jdv_connect())
  utils::View(sample)
  expect_true(used_sess_viewer())
  expect_identical(jdv::jdv_connection()$state, "embedded")
  jdv::jdv_disconnect()

  # A minimal viewer host: it records every line that jdv sends.
  received <- tempfile(fileext = ".jsonl")
  port <- NULL
  for (candidate in sample(20000:60000, 20L)) {
    host <- processx::process$new(file.path(R.home("bin"), "Rscript"), c("--vanilla", "-e", "
      args <- commandArgs(TRUE)
      server <- serverSocket(as.integer(args[1L]))
      connection <- socketAccept(server, blocking = TRUE, open = 'r+')
      repeat {
        line <- readLines(connection, n = 1L)
        if (!length(line)) break
        cat(line, '\\n', file = args[2L], append = TRUE, sep = '')
      }
    ", candidate, received), stderr = "|")
    Sys.sleep(1)
    if (host$is_alive()) {
      port <- candidate
      break
    }
  }
  if (is.null(port)) exit_file("no free TCP port for the viewer host")
  address <- sprintf("tcp://127.0.0.1:%d", port)
  stub_address(address)
  host_messages <- function(n, timeout = 10) {
    deadline <- Sys.time() + timeout
    repeat {
      lines <- if (file.exists(received)) readLines(received, warn = FALSE) else character()
      if (length(lines) >= n || Sys.time() > deadline) break
      Sys.sleep(0.05)
    }
    lapply(lines, jsonlite::fromJSON, simplifyVector = FALSE)
  }
  opens <- function() {
    Filter(function(message) identical(message$method, "view/open"), host_messages(0L))
  }

  utils::View(sample)
  expect_false(used_sess_viewer())
  messages <- host_messages(2L)
  expect_identical(messages[[1L]]$method, "hello")
  expect_identical(messages[[1L]]$params$producer$name, "jdv")
  expect_identical(runtime$jdv_address, address)
  connection <- jdv::jdv_connection()
  expect_identical(connection$state, "connected")
  expect_true(connection$persistent)
  expect_identical(connection$address, address)

  # Data frames are paged and titled by their expression.
  open <- opens()[[1L]]$params
  expect_identical(open$kind, "grid")
  expect_identical(open$access, "random")
  expect_identical(open$encoding, "jdv-json")
  expect_identical(open$collation, "C")
  expect_identical(open$title, "sample")
  expect_identical(open$generation, 1L)

  # The same title replaces the view and increments its generation.
  utils::View(sample)
  host_messages(3L)
  reopened <- opens()[[2L]]$params
  expect_identical(reopened$view, open$view)
  expect_identical(reopened$generation, 2L)

  # Lists open as trees on the same connection.
  nested <- list(a = 1:3, df = sample)
  utils::View(nested)
  host_messages(4L)
  tree <- opens()[[3L]]$params
  expect_identical(tree$kind, "tree")
  expect_identical(tree$title, "nested")
  expect_false(used_sess_viewer())

  # Arrow data is a forward-only stream on the same connection.
  if (requireNamespace("nanoarrow", quietly = TRUE)) {
    utils::View(nanoarrow::as_nanoarrow_array_stream(sample), "stream")
    host_messages(5L)
    stream <- opens()[[4L]]$params
    expect_identical(stream$access, "sequential")
    expect_identical(stream$title, "stream")
  }

  # View(<symbol>) follows the variable on R 4.6.0 or later, and never on older R.
  generations <- function(title) {
    vapply(Filter(function(open) identical(open$title, title), lapply(opens(), `[[`, "params")),
           function(open) open$generation, integer(1L))
  }
  wait_generations <- function(title, n, timeout = 5) {
    deadline <- Sys.time() + timeout
    repeat {
      jdv::jdv_rpc(NULL)
      found <- generations(title)
      if (length(found) >= n || Sys.time() > deadline) break
      Sys.sleep(0.05)
    }
    found
  }
  tracking <- data.frame(a = 1:3)
  expect_identical(sess:::.jdv_track_binding(quote(tracking), environment()),
                   if (getRversion() >= "4.6.0") list(name = "tracking", env = environment()))
  expect_null(sess:::.jdv_track_binding(quote(head(tracking)), environment()))
  expect_null(sess:::.jdv_track_binding(quote(no_such_variable_for_sess), environment()))
  options(sess.dataviewer.track = FALSE)
  expect_null(sess:::.jdv_track_binding(quote(tracking), environment()))
  options(sess.dataviewer.track = NULL)

  # The connect() setting turns tracking off; the R option overrides it.
  sess_env <- sess:::.sess_env
  setting <- sess_env$track_variables
  sess_env$track_variables <- FALSE
  expect_null(sess:::.jdv_track_binding(quote(tracking), environment()))
  options(sess.dataviewer.track = TRUE)
  expect_identical(sess:::.jdv_track_binding(quote(tracking), environment()),
                   if (getRversion() >= "4.6.0") list(name = "tracking", env = environment()))
  options(sess.dataviewer.track = NULL)
  sess_env$track_variables <- TRUE
  expect_identical(sess:::.jdv_track_binding(quote(tracking), environment()),
                   if (getRversion() >= "4.6.0") list(name = "tracking", env = environment()))
  sess_env$track_variables <- setting

  utils::View(tracking)
  expect_identical(wait_generations("tracking", 1L), 1L)
  tracking <- transform(tracking, b = a * 2L)
  if (getRversion() >= "4.6.0") {
    expect_identical(wait_generations("tracking", 2L), 1:2)
    # Assigning the same object again changes nothing.
    tracking <- tracking
    expect_identical(wait_generations("tracking", 3L, timeout = 0.5), 1:2)
  } else {
    expect_identical(wait_generations("tracking", 2L, timeout = 0.5), 1L)
  }

  # The opt-out and expressions that are not a single variable stay fixed.
  options(sess.dataviewer.track = FALSE)
  fixed <- data.frame(a = 1:3)
  utils::View(fixed)
  options(sess.dataviewer.track = NULL)
  utils::View(head(fixed), "head")
  fixed <- transform(fixed, b = a * 2L)
  expect_identical(wait_generations("fixed", 2L, timeout = 0.5), 1L)
  expect_identical(wait_generations("head", 2L, timeout = 0.5), 1L)

  # A binding that does not hold the object is dropped instead of failing View().
  expect_true(sess:::.jdv_show(fixed, "mismatch", list(name = "tracking", env = environment())))
  expect_identical(wait_generations("mismatch", 1L), 1L)

  # Sequential sources cannot be tracked, so no binding is passed for them.
  if (requireNamespace("nanoarrow", quietly = TRUE)) {
    stream <- nanoarrow::as_nanoarrow_array_stream(data.frame(a = 1:3))
    expect_true(sess:::.jdv_show(stream, "arrow", list(name = "stream", env = environment())))
    expect_identical(wait_generations("arrow", 1L), 1L)
  }

  # Explicit View() in Interactive opens the regular jdv panel before trying
  # the inline rich-output path used by ordinary cell results.
  runtime$interactive_connected <- TRUE
  utils::View(sample, "interactive explicit")
  runtime$interactive_connected <- FALSE
  host_messages(1L)
  expect_identical(tail(vapply(opens(), function(message) message$params$title, ""), 1L),
                   "interactive explicit")

  # Releasing the runtime closes the connection that sess opened.
  sess:::.jdv_release()
  expect_identical(jdv::jdv_connection()$state, "disconnected")
  expect_null(runtime$jdv_address)
})
