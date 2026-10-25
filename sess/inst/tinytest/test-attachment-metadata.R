# Exercise the installed package's real connect() and attach-metadata helper.
# Only transport/discovery dependencies are rebound; the session functions
# themselves are evaluated from the sess namespace.
local({
  namespace <- asNamespace("sess")
  state <- get(".sess_env", namespace)
  fields <- c(
    "con", "reconnect", "attachment_id", "auto_activate", "tempdir",
    "latest_plot_path", "pending_responses", "read_buffer", "dataviews",
    "dataview_registry"
  )
  saved <- lapply(fields, function(name) {
    list(exists = exists(name, envir = state, inherits = FALSE),
         value = if (exists(name, envir = state, inherits = FALSE)) get(name, state) else NULL)
  })
  names(saved) <- fields
  original_discovery <- Sys.getenv("SESS_DISCOVERY_FILE", unset = NA_character_)
  original_endpoint <- Sys.getenv("SESS_ENDPOINT", unset = NA_character_)
  on.exit({
    for (name in fields) {
      if (saved[[name]]$exists) {
        assign(name, saved[[name]]$value, envir = state)
      } else if (exists(name, envir = state, inherits = FALSE)) {
        rm(list = name, envir = state)
      }
    }
    if (is.na(original_discovery)) Sys.unsetenv("SESS_DISCOVERY_FILE") else
      Sys.setenv(SESS_DISCOVERY_FILE = original_discovery)
    if (is.na(original_endpoint)) Sys.unsetenv("SESS_ENDPOINT") else
      Sys.setenv(SESS_ENDPOINT = original_endpoint)
  }, add = TRUE)

  env <- new.env(parent = namespace)
  env$.sess_env <- state
  env$connect <- get("connect", namespace)
  environment(env$connect) <- env
  disconnects <- 0L
  env$.transport_disconnect <- function(silent = FALSE) {
    disconnects <<- disconnects + 1L
    state$con <- NULL
    state$reconnect <- NULL
  }
  env$.resolve_plot_backend <- function(plot_backend) "standard"
  env$.resolve_endpoint <- function(endpoint = NULL, ...) {
    if (is.null(endpoint)) "" else endpoint
  }

  # Invalid new options must be rejected before the old transport is touched.
  sentinel <- new.env(parent = emptyenv())
  state$con <- sentinel
  invalid <- list(
    list(attachment_id = 1L),
    list(attachment_id = NA_character_),
    list(attachment_id = "console/id"),
    list(attachment_id = strrep("a", 129L)),
    list(auto_activate = NA),
    list(auto_activate = c(TRUE, FALSE)),
    list(auto_activate = FALSE),
    list(allow_jgd = NA),
    list(allow_jgd = c(TRUE, FALSE)),
    list(allow_jgd = 1L)
  )
  for (args in invalid) {
    expect_error(do.call(env$connect, c(list(endpoint = ""), args)))
    expect_identical(state$con, sentinel)
    expect_equal(disconnects, 0L)
  }

  # The returned attach metadata reflects an external connection, then resets
  # to the historical native shape on the next untagged connect call.
  expect_warning(result <- env$connect(
    endpoint = "", attachment_id = "console_7", auto_activate = FALSE
  ), "Connection info not available")
  expect_false(result)
  metadata <- sess:::.session_attach_metadata()
  expect_equal(metadata$attachment_id, "console_7")
  expect_false(metadata$auto_activate)

  expect_warning(result <- env$connect(endpoint = ""), "Connection info not available")
  expect_false(result)
  metadata <- sess:::.session_attach_metadata()
  expect_false("attachment_id" %in% names(metadata))
  expect_false("auto_activate" %in% names(metadata))
  expect_null(state$attachment_id)
  expect_true(state$auto_activate)

  # A matching discovery endpoint keeps the same opaque options for retry.
  discovery_path <- tempfile("sess-discovery-")
  on.exit(unlink(discovery_path), add = TRUE)
  target_endpoint <- "unavailable-test-endpoint"
  Sys.setenv(SESS_DISCOVERY_FILE = discovery_path)
  env$.resolve_endpoint <- function(endpoint = NULL, ...) target_endpoint
  env$.read_discovery <- function(path) list(endpoint = target_endpoint)
  discovery_jgd_enabled <- logical()
  env$.configure_discovery_jgd <- function(discovery, jgd_enabled) {
    discovery_jgd_enabled <<- c(discovery_jgd_enabled, jgd_enabled)
  }
  invisible(env$connect(
    endpoint = target_endpoint,
    attachment_id = "console_retry_2",
    auto_activate = FALSE,
    allow_jgd = FALSE
  ))
  expect_equal(state$reconnect$options$attachment_id, "console_retry_2")
  expect_false(state$reconnect$options$auto_activate)
  expect_false(state$reconnect$options$allow_jgd)
  expect_false(tail(discovery_jgd_enabled, 1L))
})
