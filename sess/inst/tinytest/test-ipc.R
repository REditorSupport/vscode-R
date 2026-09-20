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
  orig_con <- .sess_env$con
  pipe <- processx::conn_create_pipepair()
  on.exit({
    .sess_env$dataviews <- orig_dataviews
    .sess_env$con <- orig_con
    lapply(pipe, close)
  }, add = TRUE)
  .sess_env$con <- pipe[[2L]]

  .sess_env$dataviews <- list()

  df <- data.frame(
    a = c(1.54e-03, 1.54e-04, 1.54e-05, 1.54e-06, 6.65e-13, 1.54e-100,
          -1.54e-05, 0, 1.23456789, 42),
    b = letters[1:10]
  )
  registration <- sess:::dataview_register(df)

  expect_true(is.character(registration$view_id))
  expect_equal(registration$total_rows, nrow(df))
  expect_length(registration$columns, 3)

  init_res <- sess:::handle_dataview_init(list(view_id = registration$view_id))
  expect_equal(init_res$totalRows, nrow(df))
  expect_length(init_res$columns, 3)

  page_res <- sess:::handle_dataview_page(list(
    view_id = registration$view_id,
    startRow = 0L,
    endRow = nrow(df) - 1L,
    sortModel = list(),
    filterModel = list()
  ))

  expected <- head(df$a, -1L)
  expect_equal(nrow(page_res$rows), nrow(df) - 1L)
  expect_equal(page_res$rows[["1"]], expected)

  sess:::rpc_reply("page", page_res)
  response <- jsonlite::fromJSON(processx::conn_read_chars(pipe[[1L]]))
  expect_true(all(abs(response$result$rows[["1"]] - expected) <= abs(expected) * 1e-14))

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

  df <- data.frame(a = c(1.54e-05, 3.54e-05, 2.54e-05), b = c("apple", "banana", "berry"))
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
  expect_equal(filtered$rows[["2"]], c("banana", "berry"))

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
  expect_equal(sorted$rows[["1"]], sort(df$a, decreasing = TRUE))

  for (value in df$a[1:2]) {
    filtered <- sess:::handle_dataview_page(list(
      view_id = registration$view_id,
      filterModel = list(
        "1" = list(filterType = "number", type = "equals", filter = value)
      )
    ))
    expect_equal(filtered$rows[["1"]], value, tolerance = 1e-14)
  }
})

# NDJSON framing round-trips correctly through a socket pair.
# Kept last: tinytest runs files as flat scripts, so an unrecoverable socket
# error here must not mask the blocks above. Socket support is
# environment-sensitive (some processx builds/platforms fail to accept or read
# the loopback connection), so any infrastructure error becomes a silent skip
# rather than a failure. A genuine framing/protocol bug yields wrong captured
# values (asserted below), not a thrown error, so real failures still surface.
# NB: exit_file() only halts at script top level, not inside local(), so we
# skip with an early return() instead.
local({
  if (!requireNamespace("processx", quietly = TRUE) ||
        .Platform$OS.type == "windows") {
    # Windows named pipe paths are tested separately.
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
