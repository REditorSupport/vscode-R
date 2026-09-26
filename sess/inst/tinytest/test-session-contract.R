# The attach identity and protocol metadata are process-scoped, not connection-scoped.
local({
  expect_true("endpoint" %in% names(formals(sess::connect)))
  first <- sess:::.session_attach_metadata()
  second <- sess:::.session_attach_metadata()

  expect_equal(first$protocol_version, 1L)
  expect_true(is.character(first$session_id) && nzchar(first$session_id))
  expect_equal(first$session_id, second$session_id)
  expect_false(identical(first$session_id, as.character(first$pid)))
  expect_true(is.character(first$host))
  expect_true(nzchar(first$sess_version))
  expect_equal(first$pid, Sys.getpid())
})

# A fork child inherits the namespace environment, but must get its own identity.
local({
  sess_env <- sess:::.sess_env
  old_session_id <- sess_env$session_id
  old_session_pid <- sess_env$session_pid
  on.exit({
    sess_env$session_id <- old_session_id
    sess_env$session_pid <- old_session_pid
  })

  inherited_pid <- if (Sys.getpid() == 1L) 2L else 1L
  sess_env$session_pid <- inherited_pid
  first <- sess:::.session_id()
  second <- sess:::.session_id()

  expect_false(identical(first, old_session_id))
  expect_equal(first, second)
  expect_equal(sess_env$session_pid, Sys.getpid())
})

# Explicit endpoint and environment handoffs take precedence.
local({
  expect_equal(
    sess:::.resolve_endpoint("explicit", env_endpoint = "env", env_discovery_file = ""),
    "explicit"
  )
  expect_equal(
    sess:::.resolve_endpoint(NULL, env_endpoint = "env", env_discovery_file = ""),
    "env"
  )
})

# Canonical discovery uses SESS_DISCOVERY_FILE and versioned `endpoint`.
local({
  path <- tempfile(fileext = ".json")
  on.exit(unlink(path), add = TRUE)

  writeLines('{"version":1,"endpoint":"canonical-endpoint","terminalPid":321}', path)
  expect_equal(
    sess:::.resolve_endpoint(
      NULL, env_endpoint = "environment-endpoint", env_discovery_file = path
    ),
    "environment-endpoint"
  )
  expect_equal(
    sess:::.resolve_endpoint(
      NULL, env_endpoint = "", env_discovery_file = path
    ),
    "canonical-endpoint"
  )

  # An explicit discovery path is authoritative, even if it is absent.
  expect_warning(
    expect_equal(
      sess:::.resolve_endpoint(
        NULL, env_endpoint = "", env_discovery_file = paste0(path, ".missing")
      ),
      ""
    ),
    "does not exist"
  )

  writeLines('{"version":2,"endpoint":"future-endpoint"}', path)
  expect_warning(
    expect_equal(
      sess:::.resolve_endpoint(NULL, env_endpoint = "", env_discovery_file = path),
      ""
    ),
    "Unsupported session discovery version"
  )

  invalid_versions <- c(
    '{"version":1.5,"endpoint":"fractional-endpoint"}',
    '{"version":1.0,"endpoint":"double-endpoint"}',
    '{"version":"1","endpoint":"string-endpoint"}',
    '{"version":"1.5","endpoint":"string-endpoint"}',
    '{"version":[1],"endpoint":"array-endpoint"}'
  )
  for (json in invalid_versions) {
    writeLines(json, path)
    expect_warning(
      expect_equal(
        sess:::.resolve_endpoint(NULL, env_endpoint = "", env_discovery_file = path),
        ""
      ),
      "Unsupported session discovery version"
    )
  }

  writeLines('{"version":1,"pipe":"obsolete-field"}', path)
  expect_warning(
    expect_equal(
      sess:::.resolve_endpoint(NULL, env_endpoint = "", env_discovery_file = path),
      ""
    ),
    "has no endpoint"
  )
})

# Optional renderer fields extend version 1 without changing the core contract.
local({
  path <- tempfile(fileext = ".json")
  on.exit(unlink(path), add = TRUE)
  writeLines(paste0(
    '{"version":1,"endpoint":"sess-endpoint",',
    '"futureRenderer":{"endpoint":"future-socket","version":99},',
    '"env":{"JGD_SOCKET":"must-not-be-applied"}}'
  ), path)
  expect_equal(sess:::.read_discovery_endpoint(path), "sess-endpoint")
  original_jgd <- Sys.getenv("JGD_SOCKET", unset = NA_character_)
  on.exit({
    if (is.na(original_jgd)) Sys.unsetenv("JGD_SOCKET") else
      Sys.setenv(JGD_SOCKET = original_jgd)
  }, add = TRUE)
  Sys.setenv(JGD_SOCKET = "external-socket")
  sess:::.configure_discovery_jgd(sess:::.read_discovery(path), TRUE)
  expect_equal(Sys.getenv("JGD_SOCKET"), "external-socket")

  writeLines('{"version":1,"endpoint":"sess-endpoint","jgdSocket":"new-socket"}', path)
  discovery <- sess:::.read_discovery(path)
  expect_equal(discovery$jgdSocket, "new-socket")
  sess:::.configure_discovery_jgd(discovery, FALSE)
  expect_equal(Sys.getenv("JGD_SOCKET"), "external-socket")
  sess:::.configure_discovery_jgd(discovery, TRUE)
  expect_equal(Sys.getenv("JGD_SOCKET"), "new-socket")

  writeLines('{"version":1,"endpoint":"sess-endpoint","jgdSocket":""}', path)
  sess:::.configure_discovery_jgd(sess:::.read_discovery(path), TRUE)
  expect_equal(Sys.getenv("JGD_SOCKET", unset = "<unset>"), "<unset>")

  for (value in c("null", "123", "true", '["socket"]', "{}")) {
    writeLines(paste0('{"version":1,"endpoint":"sess-endpoint","jgdSocket":', value, "}"), path)
    expect_warning(expect_null(sess:::.read_discovery(path, warn = TRUE)), "Invalid jgdSocket")
  }
})
