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
