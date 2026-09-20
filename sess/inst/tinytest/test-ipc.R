# dispatch_message routes responses to pending_responses
local({
  .sess_env <- sess:::.sess_env
  orig_pending <- .sess_env$pending_responses
  on.exit(.sess_env$pending_responses <- orig_pending, add = TRUE)

  .sess_env$pending_responses <- list()

  response_line <- as.character(jsonlite::toJSON(
    list(jsonrpc = "2.0", id = "req_001", result = list(x = 1L)),
    auto_unbox = TRUE
  ))

  sess:::dispatch_message(response_line)

  expect_false(is.null(.sess_env$pending_responses[["req_001"]]))
  expect_equal(.sess_env$pending_responses[["req_001"]]$x, 1L)
})

# dispatch_message stores JSON-RPC errors with error class
local({
  .sess_env <- sess:::.sess_env
  orig_pending <- .sess_env$pending_responses
  on.exit(.sess_env$pending_responses <- orig_pending, add = TRUE)

  .sess_env$pending_responses <- list()

  error_line <- as.character(jsonlite::toJSON(
    list(jsonrpc = "2.0", id = "req_002",
         error = list(code = -32601L, message = "Method not found")),
    auto_unbox = TRUE
  ))

  sess:::dispatch_message(error_line)

  resp <- .sess_env$pending_responses[["req_002"]]
  expect_false(is.null(resp))
  expect_inherits(resp, "json_rpc_error")
  expect_equal(resp$code, -32601L)
})

# ipc_write returns FALSE when no connection is open
local({
  .sess_env <- sess:::.sess_env
  orig_con <- .sess_env$con
  on.exit(.sess_env$con <- orig_con, add = TRUE)

  .sess_env$con <- NULL
  result <- sess:::ipc_write(list(jsonrpc = "2.0", method = "test"))
  expect_false(isTRUE(result))
})

# Environment expansion must retain visible members when hidden bindings exist (R6).
local({
  name <- basename(tempfile("workspace_environment_"))
  object <- new.env(parent = emptyenv())
  object$values <- list(first = 1L)
  object$.hidden <- TRUE
  assign(name, object, envir = .GlobalEnv)
  on.exit(rm(list = name, envir = .GlobalEnv), add = TRUE)

  page <- sess:::get_workspace_children(name)
  expect_equal(
    lapply(page$children, function(child) child$selector),
    list(list(kind = "name", value = "values"))
  )
})

# dataview init/page/dispose lifecycle works
local({
  .sess_env <- sess:::.sess_env
  orig_dataviews <- .sess_env$dataviews
  on.exit(.sess_env$dataviews <- orig_dataviews, add = TRUE)

  .sess_env$dataviews <- list()

  df <- data.frame(a = c(3, 1, 2), b = c("x", "y", "z"), stringsAsFactors = FALSE)
  registration <- sess:::dataview_register(df)

  expect_true(is.character(registration$view_id))
  expect_equal(registration$total_rows, 3)
  expect_length(registration$columns, 3)

  init_res <- sess:::handle_dataview_init(list(view_id = registration$view_id))
  expect_equal(init_res$totalRows, 3)
  expect_length(init_res$columns, 3)

  page_res <- sess:::handle_dataview_page(list(
    view_id = registration$view_id,
    startRow = 0L,
    endRow = 2L,
    sortModel = list(),
    filterModel = list()
  ))

  expect_true(is.data.frame(page_res$rows))
  expect_equal(nrow(page_res$rows), 2)
  expect_equal(page_res$rows[["1"]][[1L]], 3)
  expect_equal(page_res$rows[["1"]][[2L]], 1)

  disposed <- sess:::handle_dataview_dispose(list(view_id = registration$view_id))
  expect_true(isTRUE(disposed))
  expect_error(
    sess:::handle_dataview_init(list(view_id = registration$view_id)),
    "Unknown dataview id"
  )
})

# dataview paging applies global filter and sort
local({
  .sess_env <- sess:::.sess_env
  orig_dataviews <- .sess_env$dataviews
  on.exit(.sess_env$dataviews <- orig_dataviews, add = TRUE)

  .sess_env$dataviews <- list()

  df <- data.frame(a = c(10, 30, 20), b = c("apple", "banana", "berry"), stringsAsFactors = FALSE)
  registration <- sess:::dataview_register(df)

  filtered <- sess:::handle_dataview_page(list(
    view_id = registration$view_id,
    startRow = 0L,
    endRow = 10L,
    sortModel = list(),
    filterModel = list(
      "2" = list(filterType = "text", type = "contains", filter = "b")
    )
  ))

  expect_equal(filtered$totalRows, 2)
  expect_equal(nrow(filtered$rows), 2)
  expect_equal(filtered$rows[["2"]][[1L]], "banana")
  expect_equal(filtered$rows[["2"]][[2L]], "berry")

  sorted <- sess:::handle_dataview_page(list(
    view_id = registration$view_id,
    startRow = 0L,
    endRow = 10L,
    sortModel = list(
      list(colId = "1", sort = "desc")
    ),
    filterModel = list()
  ))

  expect_equal(sorted$totalRows, 3)
  expect_equal(sorted$rows[["1"]][[1L]], 30)
  expect_equal(sorted$rows[["1"]][[2L]], 20)
  expect_equal(sorted$rows[["1"]][[3L]], 10)
})

# Runtime startup and shutdown are reversible and idempotent.
local({
  .sess_env <- sess:::.sess_env
  old_plot_path <- .sess_env$latest_plot_path
  old_dataviews <- .sess_env$dataviews
  old_dataview_registry <- .sess_env$dataview_registry
  .sess_env$latest_plot_path <- tempfile(fileext = ".png")
  on.exit({
    sess:::runtime_stop()
    unlink(.sess_env$latest_plot_path)
    .sess_env$latest_plot_path <- old_plot_path
    .sess_env$dataviews <- old_dataviews
    .sess_env$dataview_registry <- old_dataview_registry
  }, add = TRUE)

  utils_ns <- asNamespace("utils")
  old_view <- get("View", utils_ns, inherits = FALSE)
  old_options <- lapply(c("browser", "viewer", "page_viewer", "help_type", "device"), getOption)
  names(old_options) <- c("browser", "viewer", "page_viewer", "help_type", "device")
  old_plot_hook <- getHook("plot.new")
  old_grid_hook <- getHook("grid.newpage")
  old_help_method <- utils::getS3method("print", "help_files_with_topic",
                                        envir = utils_ns)

  stale_registry <- new.env(parent = emptyenv())
  assign("stale view", "stale_view_id", envir = stale_registry)
  .sess_env$dataviews <- list(stale_view_id = list())
  .sess_env$dataview_registry <- stale_registry
  sess:::runtime_stop()
  expect_equal(.sess_env$dataviews, list())
  expect_length(ls(.sess_env$dataview_registry, all.names = TRUE), 0L)

  sess:::runtime_start(use_rstudioapi = FALSE, use_httpgd = FALSE, use_jgd = FALSE)
  expect_equal(.sess_env$dataviews, list())
  expect_length(ls(.sess_env$dataview_registry, all.names = TRUE), 0L)
  expect_true(isTRUE(sess:::.runtime_state()$active))
  expect_false(identical(get("View", utils_ns, inherits = FALSE), old_view))
  expect_true(is.function(getOption("viewer")))
  expect_false(identical(utils::getS3method("print", "help_files_with_topic",
                                            envir = utils_ns), old_help_method))
  expect_equal(length(grep("^sess.workspace$", getTaskCallbackNames())), 1L)
  expect_false(identical(getHook("plot.new"), old_plot_hook))
  expect_false(identical(getHook("grid.newpage"), old_grid_hook))

  dataview_data <- data.frame(value = 1:2)
  assign("lifecycle dataview", "runtime_view_before_restart",
         envir = .sess_env$dataview_registry)
  utils::View(dataview_data, title = "lifecycle dataview")
  first_view_id <- get("lifecycle dataview", envir = .sess_env$dataview_registry)
  expect_identical(first_view_id, "runtime_view_before_restart")
  expect_true(first_view_id %in% names(.sess_env$dataviews))

  grDevices::pdf(NULL)
  sess:::.runtime_track_device()
  runtime_device <- grDevices::dev.cur()

  callbacks_after_first_start <- getTaskCallbackNames()
  sess:::runtime_start(use_rstudioapi = FALSE, use_httpgd = FALSE, use_jgd = FALSE)
  expect_equal(.sess_env$dataviews, list())
  expect_length(ls(.sess_env$dataview_registry, all.names = TRUE), 0L)
  expect_equal(length(grep("^sess.workspace$", getTaskCallbackNames())), 1L)
  expect_equal(length(grep("^sess.plot$", getTaskCallbackNames())),
               length(grep("^sess.plot$", callbacks_after_first_start)))

  utils::View(dataview_data, title = "lifecycle dataview")
  second_view_id <- get("lifecycle dataview", envir = .sess_env$dataview_registry)
  expect_false(identical(first_view_id, second_view_id))
  expect_true(second_view_id %in% names(.sess_env$dataviews))

  sess:::runtime_stop()
  expect_equal(.sess_env$dataviews, list())
  expect_length(ls(.sess_env$dataview_registry, all.names = TRUE), 0L)
  expect_error(
    sess:::handle_dataview_init(list(view_id = second_view_id)),
    "Unknown dataview id"
  )
  expect_false(isTRUE(sess:::.runtime_state()$active))
  expect_identical(get("View", utils_ns, inherits = FALSE), old_view)
  expect_identical(getOption("browser"), old_options$browser)
  expect_identical(getOption("viewer"), old_options$viewer)
  expect_identical(getOption("page_viewer"), old_options$page_viewer)
  expect_identical(getOption("help_type"), old_options$help_type)
  expect_identical(getOption("device"), old_options$device)
  expect_identical(getHook("plot.new"), old_plot_hook)
  expect_identical(getHook("grid.newpage"), old_grid_hook)
  expect_false(runtime_device %in% grDevices::dev.list())
  expect_identical(utils::getS3method("print", "help_files_with_topic",
                                      envir = utils_ns), old_help_method)
  expect_equal(length(grep("^sess.workspace$", getTaskCallbackNames())), 0L)
  expect_equal(length(grep("^sess.plot$", getTaskCallbackNames())), 0L)
})

# Cleanup preserves options and bindings changed by user code after startup.
local({
  .sess_env <- sess:::.sess_env
  old_plot_path <- .sess_env$latest_plot_path
  .sess_env$latest_plot_path <- tempfile(fileext = ".png")
  utils_ns <- asNamespace("utils")
  original_view <- get("View", utils_ns, inherits = FALSE)
  binding_was_locked <- bindingIsLocked("View", utils_ns)
  original_viewer <- getOption("viewer")
  user_view <- function(...) "user view"
  user_viewer <- function(...) "user viewer"
  on.exit({
    sess:::runtime_stop()
    if (binding_was_locked) unlockBinding("View", utils_ns)
    assign("View", original_view, envir = utils_ns)
    if (binding_was_locked) lockBinding("View", utils_ns)
    options(viewer = original_viewer)
    unlink(.sess_env$latest_plot_path)
    .sess_env$latest_plot_path <- old_plot_path
  }, add = TRUE)

  sess:::runtime_start(use_rstudioapi = FALSE, use_httpgd = FALSE, use_jgd = FALSE)
  options(viewer = user_viewer)
  if (binding_was_locked) unlockBinding("View", utils_ns)
  assign("View", user_view, envir = utils_ns)
  if (binding_was_locked) lockBinding("View", utils_ns)
  sess:::runtime_stop()

  expect_identical(getOption("viewer"), user_viewer)
  expect_identical(get("View", utils_ns, inherits = FALSE), user_view)
})

# rstudioapi overrides and its package-load hook are restored at runtime stop.
local({
  if (!requireNamespace("rstudioapi", quietly = TRUE)) return(invisible(NULL))
  rstudioapi_ns <- asNamespace("rstudioapi")
  if (!exists("isAvailable", envir = rstudioapi_ns, inherits = FALSE)) {
    return(invisible(NULL))
  }

  .sess_env <- sess:::.sess_env
  old_plot_path <- .sess_env$latest_plot_path
  .sess_env$latest_plot_path <- tempfile(fileext = ".png")
  original_is_available <- get("isAvailable", rstudioapi_ns, inherits = FALSE)
  rstudioapi_hook_name <- packageEvent("rstudioapi", "onLoad")
  original_load_hook <- getHook(rstudioapi_hook_name)
  on.exit({
    sess:::runtime_stop()
    unlink(.sess_env$latest_plot_path)
    .sess_env$latest_plot_path <- old_plot_path
  }, add = TRUE)

  sess:::runtime_start(use_rstudioapi = TRUE, use_httpgd = FALSE, use_jgd = FALSE)
  expect_false(identical(get("isAvailable", rstudioapi_ns, inherits = FALSE),
                         original_is_available))
  expect_false(identical(getHook(rstudioapi_hook_name), original_load_hook))

  sess:::runtime_stop()
  expect_identical(get("isAvailable", rstudioapi_ns, inherits = FALSE),
                   original_is_available)
  expect_identical(getHook(rstudioapi_hook_name), original_load_hook)
})

# An empty ready-read is EOF only after processx confirms no more data can
# arrive. Errors from the EOF check are treated conservatively as still open.
local({
  if (!requireNamespace("processx", quietly = TRUE)) return(invisible(NULL))
  cons <- tryCatch(processx::conn_create_pipepair(), error = function(e) NULL)
  if (is.null(cons)) return(invisible(NULL))
  on.exit({
    try(close(cons[[1L]]), silent = TRUE)
    try(close(cons[[2L]]), silent = TRUE)
  }, add = TRUE)

  expect_false(sess:::.transport_empty_read_is_eof(cons[[2L]]))
  expect_false(sess:::.transport_empty_read_is_eof(NULL))
  close(cons[[1L]])
  chunk <- processx::conn_read_chars(cons[[2L]])
  expect_true(is.null(chunk) || !length(chunk) || !any(nzchar(chunk)))
  expect_true(sess:::.transport_empty_read_is_eof(cons[[2L]]))
})

# EOF observed by the polling loop stops the runtime and releases the transport
# on every platform without depending on a Unix-domain socket.
local({
  if (!requireNamespace("processx", quietly = TRUE)) return(invisible(NULL))
  cons <- tryCatch(processx::conn_create_pipepair(), error = function(e) NULL)
  if (is.null(cons)) return(invisible(NULL))

  .sess_env <- sess:::.sess_env
  old_plot_path <- .sess_env$latest_plot_path
  .sess_env$latest_plot_path <- tempfile(fileext = ".png")
  on.exit({
    sess:::.transport_disconnect(silent = TRUE)
    try(close(cons[[1L]]), silent = TRUE)
    try(close(cons[[2L]]), silent = TRUE)
    unlink(.sess_env$latest_plot_path)
    .sess_env$latest_plot_path <- old_plot_path
  }, add = TRUE)

  .sess_env$con <- cons[[2L]]
  .sess_env$transport_generation <- if (is.null(.sess_env$transport_generation)) {
    1L
  } else {
    .sess_env$transport_generation + 1L
  }
  sess:::runtime_start(use_rstudioapi = FALSE, use_httpgd = FALSE, use_jgd = FALSE)
  expect_true(isTRUE(sess:::.runtime_state()$active))

  close(cons[[1L]])
  sess:::poll_connection(.sess_env$transport_generation)
  expect_null(.sess_env$con)
  expect_false(isTRUE(sess:::.runtime_state()$active))
  expect_equal(length(grep("^sess.workspace$", getTaskCallbackNames())), 0L)
})

# NDJSON framing round-trips correctly through a socket pair. Socket support is
# environment-sensitive (some processx builds/platforms fail to accept or read
# the loopback connection), so any infrastructure error becomes a silent skip
# rather than a failure. A genuine framing/protocol bug yields wrong captured
# values (asserted below), not a thrown error, so real failures still surface.
# NB: exit_file() only halts at script top level, not inside local(), so we
# skip with an early return() instead.
local({
  if (!requireNamespace("processx", quietly = TRUE) ||
        .Platform$OS.type == "windows") {
    # This check specifically exercises Unix-domain socket framing.
    return(invisible(NULL))
  }

  pipe_path <- tempfile(fileext = ".sock")
  cons <- new.env()
  on.exit({
    for (nm in ls(cons)) try(close(cons[[nm]]), silent = TRUE)
    unlink(pipe_path)
  }, add = TRUE)

  res <- tryCatch({
    cons$server <- processx::conn_create_unix_socket(pipe_path, encoding = "")
    cons$client <- processx::conn_connect_unix_socket(pipe_path, encoding = "")

    # Accept the incoming client on the server side
    processx::poll(list(cons$server), 1000L)
    cons$conn <- processx::conn_accept_unix_socket(cons$server)
    if (is.null(cons$conn)) stop("conn_accept_unix_socket returned NULL")

    # Write a NDJSON line from client to server
    msg <- list(jsonrpc = "2.0", method = "ping", params = list(value = 42L))
    line <- paste0(jsonlite::toJSON(msg, auto_unbox = TRUE), "\n")
    processx::conn_write(cons$client, line, sep = "")

    # Poll and read on server side
    ready <- processx::poll(list(cons$conn), 1000L)
    received <- processx::conn_read_chars(cons$conn)
    parsed <- jsonlite::fromJSON(trimws(received), simplifyVector = FALSE)
    list(ready = ready[[1]], received = received,
         method = parsed$method, value = parsed$params$value)
  }, error = function(e) NULL)

  if (is.null(res)) {
    return(invisible(NULL))
  }

  expect_equal(res$ready, "ready")
  expect_true(nzchar(res$received))
  expect_equal(res$method, "ping")
  expect_equal(res$value, 42L)
})

# A peer disappearing while a request is waiting stops the runtime, and a new
# connection can start a fresh runtime without duplicating callbacks.
local({
  .sess_env <- sess:::.sess_env
  if (!requireNamespace("processx", quietly = TRUE) || .Platform$OS.type == "windows") {
    return(invisible(NULL))
  }

  listener <- function() {
    path <- tempfile(fileext = ".sock")
    server <- tryCatch(processx::conn_create_unix_socket(path, encoding = ""),
                       error = function(e) NULL)
    if (is.null(server)) return(NULL)
    list(path = path, server = server)
  }
  accept_peer <- function(server) {
    ready <- tryCatch(processx::poll(list(server), 1000L), error = function(e) NULL)
    if (is.null(ready) || !ready[[1]] %in% c("connect", "ready")) return(NULL)
    tryCatch(processx::conn_accept_unix_socket(server), error = function(e) NULL)
  }

  first <- listener()
  if (is.null(first)) return(invisible(NULL))
  utils_ns <- asNamespace("utils")
  original_view <- get("View", utils_ns, inherits = FALSE)
  option_names <- c("browser", "viewer", "page_viewer", "help_type", "device")
  original_options <- lapply(option_names, getOption)
  names(original_options) <- option_names
  original_help_method <- utils::getS3method("print", "help_files_with_topic",
                                             envir = utils_ns)
  original_plot_hook <- getHook("plot.new")
  original_grid_hook <- getHook("grid.newpage")
  second <- NULL
  first_peer <- NULL
  second_peer <- NULL
  on.exit({
    sess:::.transport_disconnect()
    for (con in list(first_peer, second_peer, first$server,
                     if (!is.null(second)) second$server else NULL)) {
      if (!is.null(con)) try(close(con), silent = TRUE)
    }
    unlink(c(first$path, if (!is.null(second)) second$path else character()))
  }, add = TRUE)

  connected <- tryCatch({
    sess::connect(first$path, use_rstudioapi = FALSE,
                  use_httpgd = FALSE, use_jgd = FALSE)
    first_peer <- accept_peer(first$server)
    !is.null(first_peer) && !is.null(.sess_env$con)
  }, error = function(e) FALSE)
  if (!isTRUE(connected)) return(invisible(NULL))

  close(first_peer)
  result <- suppressWarnings(sess::request_client("test/disconnect_wait"))
  expect_false(isTRUE(result))
  expect_null(.sess_env$con)
  expect_false(isTRUE(sess:::.runtime_state()$active))
  expect_identical(get("View", utils_ns, inherits = FALSE), original_view)
  expect_identical(getOption("browser"), original_options$browser)
  expect_identical(getOption("viewer"), original_options$viewer)
  expect_identical(getOption("page_viewer"), original_options$page_viewer)
  expect_identical(getOption("help_type"), original_options$help_type)
  expect_identical(getOption("device"), original_options$device)
  expect_identical(utils::getS3method("print", "help_files_with_topic",
                                      envir = utils_ns), original_help_method)
  expect_identical(getHook("plot.new"), original_plot_hook)
  expect_identical(getHook("grid.newpage"), original_grid_hook)
  expect_equal(length(grep("^sess.workspace$", getTaskCallbackNames())), 0L)
  expect_equal(length(grep("^sess.plot$", getTaskCallbackNames())), 0L)

  second <- listener()
  if (is.null(second)) return(invisible(NULL))
  sess::connect(second$path, use_rstudioapi = FALSE,
                use_httpgd = FALSE, use_jgd = FALSE)
  second_peer <- accept_peer(second$server)
  if (is.null(second_peer) || is.null(.sess_env$con)) return(invisible(NULL))
  expect_true(isTRUE(sess:::.runtime_state()$active))
  expect_equal(length(grep("^sess.workspace$", getTaskCallbackNames())), 1L)
  sess:::.transport_disconnect()
  expect_null(.sess_env$con)
  expect_false(isTRUE(sess:::.runtime_state()$active))
})

# A transport write failure also stops the runtime promptly.
local({
  .sess_env <- sess:::.sess_env
  if (!requireNamespace("processx", quietly = TRUE) || .Platform$OS.type == "windows") {
    return(invisible(NULL))
  }

  path <- tempfile(fileext = ".sock")
  server <- tryCatch(processx::conn_create_unix_socket(path, encoding = ""),
                     error = function(e) NULL)
  if (is.null(server)) return(invisible(NULL))
  peer <- NULL
  on.exit({
    sess:::.transport_disconnect()
    if (!is.null(peer)) try(close(peer), silent = TRUE)
    try(close(server), silent = TRUE)
    unlink(path)
  }, add = TRUE)

  connected <- tryCatch({
    sess::connect(path, use_rstudioapi = FALSE, use_httpgd = FALSE, use_jgd = FALSE)
    ready <- processx::poll(list(server), 1000L)
    if (ready[[1]] %in% c("connect", "ready")) {
      peer <- processx::conn_accept_unix_socket(server)
    }
    !is.null(peer) && !is.null(.sess_env$con)
  }, error = function(e) FALSE)
  if (!isTRUE(connected)) return(invisible(NULL))

  close(.sess_env$con)
  sent <- suppressWarnings(sess:::ipc_write(list(method = "test/write_failure")))
  expect_false(isTRUE(sent))
  expect_null(.sess_env$con)
  expect_false(isTRUE(sess:::.runtime_state()$active))
})
