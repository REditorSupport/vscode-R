# Explicit backends preserve native behavior and keep it distinct from the
# standard static viewer.
local({
  resolve <- sess:::.resolve_plot_backend
  select <- sess:::.select_plot_backend
  choices <- c("auto", "jgd", "httpgd", "standard", "native")
  expect_equal(eval(formals(sess::connect)$plot_backend), choices)
  expect_equal(resolve(choices), "auto")
  expect_equal(resolve(NULL), "auto")
  for (backend in c("auto", "jgd", "httpgd", "standard", "native")) {
    expect_equal(resolve(backend), backend)
  }
  expect_equal(select("auto", TRUE, TRUE), "jgd")
  expect_equal(select("auto", TRUE, FALSE), "httpgd")
  expect_equal(select("auto", FALSE, TRUE), "jgd")
  expect_equal(select("auto", FALSE, FALSE), "standard")
  expect_equal(select("jgd", TRUE, TRUE), "jgd")
  expect_equal(select("httpgd", FALSE, TRUE), "standard")
  expect_equal(select("native", TRUE, TRUE), "native")
})

local({
  sess:::runtime_stop()
  sentinel_device <- function(...) stop("R's device option was used")
  original_device <- getOption("device")
  original_null_dev <- getOption("sess.null_dev")
  original_plot_hook <- getHook("plot.new")
  original_grid_hook <- getHook("grid.newpage")
  original_devices <- grDevices::dev.list()
  options(device = sentinel_device)
  on.exit({
    sess:::runtime_stop()
    options(device = original_device)
  }, add = TRUE)

  sess:::runtime_start(use_rstudioapi = FALSE, plot_backend = "native")
  state <- sess:::.runtime_state()
  expect_true(isTRUE(state$active))
  expect_true(identical(getOption("device"), sentinel_device))
  expect_equal(getOption("sess.null_dev"), original_null_dev)
  expect_equal(getHook("plot.new"), original_plot_hook)
  expect_equal(getHook("grid.newpage"), original_grid_hook)
  expect_equal(grDevices::dev.list(), original_devices)
  expect_false("sess.plot" %in% unlist(state$task_callbacks))
  expect_true("sess.workspace" %in% unlist(state$task_callbacks))
  expect_length(state$devices, 0L)
  expect_true(is.function(getOption("viewer")))

  sess:::runtime_stop()
  expect_true(identical(getOption("device"), sentinel_device))
  expect_equal(grDevices::dev.list(), original_devices)
})

# Removed arguments are rejected before connect changes transport or runtime state.
local({
  env <- new.env(parent = asNamespace("sess"))
  entry <- sess::connect
  environment(entry) <- env
  disconnected <- FALSE
  env$.transport_disconnect <- function(...) {
    disconnected <<- TRUE
    stop("connect reached transport cleanup")
  }
  for (arg in c("use_httpgd", "use_jgd")) {
    failure <- tryCatch(do.call(entry, setNames(list(TRUE), arg)), error = identity)
    expect_true(inherits(failure, "error"))
    expect_true(grepl("unused argument", conditionMessage(failure), fixed = TRUE))
    expect_false(disconnected)
  }
  expect_false("register_hooks" %in% getNamespaceExports("sess"))
})

# The public connection path stores native for discovery reconnects and still
# initializes the non-plot runtime without replacing a profile device option.
local({
  endpoint <- if (.Platform$OS.type == "windows") {
    paste0("\\\\?\\pipe\\", basename(tempfile("sess-native-")))
  } else {
    tempfile(fileext = ".sock")
  }
  server <- tryCatch(processx::conn_create_unix_socket(endpoint, encoding = ""),
                     error = function(e) NULL)
  if (is.null(server)) return(invisible(NULL))
  discovery <- tempfile(fileext = ".json")
  writeLines(jsonlite::toJSON(list(version = 1L, endpoint = endpoint),
                              auto_unbox = TRUE), discovery)
  old_discovery <- Sys.getenv("SESS_DISCOVERY_FILE", unset = NA_character_)
  Sys.setenv(SESS_DISCOVERY_FILE = discovery)
  sentinel_device <- function(...) stop("R's device option was used")
  original_device <- getOption("device")
  original_devices <- grDevices::dev.list()
  options(device = sentinel_device)
  on.exit({
    sess:::.transport_disconnect(silent = TRUE)
    try(close(server), silent = TRUE)
    unlink(c(discovery, if (.Platform$OS.type != "windows") endpoint))
    if (is.na(old_discovery)) Sys.unsetenv("SESS_DISCOVERY_FILE") else
      Sys.setenv(SESS_DISCOVERY_FILE = old_discovery)
    options(device = original_device)
  }, add = TRUE)

  env <- new.env(parent = asNamespace("sess"))
  env$connect <- sess::connect
  environment(env$connect) <- env
  env$poll_connection <- function(...) {
    processx::poll(list(server), 1000L)
    processx::conn_accept_unix_socket(server)
    processx::poll(list(server), 1000L)
    expect_equal(jsonlite::fromJSON(processx::conn_read_chars(server))$method,
                 "attach")
  }
  env$connect(endpoint = endpoint, use_rstudioapi = FALSE,
              plot_backend = "native")
  expect_true(isTRUE(sess:::.runtime_state()$active))
  expect_true(identical(getOption("device"), sentinel_device))
  expect_equal(grDevices::dev.list(), original_devices)
  expect_equal(sess:::.sess_env$reconnect$options$plot_backend, "native")
  expect_false("sess.plot" %in% getTaskCallbackNames())
})
