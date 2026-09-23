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

# Explicit endpoint and canonical environment variable take precedence.
local({
  expect_equal(
    sess:::.resolve_endpoint("explicit", env_endpoint = "env", env_pipe = "old"),
    "explicit"
  )
  expect_equal(
    sess:::.resolve_endpoint(NULL, env_endpoint = "env", env_pipe = "old"),
    "env"
  )
  expect_equal(
    sess:::.resolve_endpoint(NULL, env_endpoint = "", env_pipe = "old"),
    "old"
  )
})

# Discovery follows Node's home-directory choice on Windows, even when R's `~`
# expands to Documents. On Unix it continues to use the R home expansion.
local({
  pid <- 12345L
  windows_profile_path <- sess:::.discovery_file_path(
    pid = pid,
    platform = "windows",
    user_profile = "C:/Users/alice",
    home_drive = "E:",
    home_path = "\\Users\\alice",
    home = "C:/Users/alice/Documents"
  )
  expect_equal(
    windows_profile_path,
    file.path("C:/Users/alice", ".vscode-R", "sessions", "12345.json")
  )

  windows_fallback_path <- sess:::.discovery_file_path(
    pid = pid,
    platform = "windows",
    user_profile = "",
    home_drive = "E:",
    home_path = "\\Users\\alice",
    home = "C:/Users/alice/Documents"
  )
  expect_equal(
    windows_fallback_path,
    file.path("E:\\Users\\alice", ".vscode-R", "sessions", "12345.json")
  )

  unix_path <- sess:::.discovery_file_path(
    pid = pid,
    platform = "unix",
    user_profile = "C:/Users/alice",
    home_drive = "E:",
    home_path = "\\Users\\alice",
    home = "/home/alice"
  )
  expect_equal(unix_path, file.path("/home/alice", ".vscode-R", "sessions", "12345.json"))
})

# Discovery uses versioned `endpoint`; an old pipe field remains a compatibility fallback.
local({
  path <- tempfile(fileext = ".json")
  on.exit(unlink(path), add = TRUE)

  writeLines('{"version":1,"endpoint":"canonical-endpoint"}', path)
  expect_equal(
    sess:::.resolve_endpoint(NULL, path, env_endpoint = "", env_pipe = ""),
    "canonical-endpoint"
  )

  writeLines('{"version":1,"pipe":"legacy-pipe"}', path)
  expect_equal(
    sess:::.resolve_endpoint(NULL, path, env_endpoint = "", env_pipe = ""),
    "legacy-pipe"
  )

  writeLines('{"version":2,"endpoint":"future-endpoint"}', path)
  expect_warning(
    expect_equal(
      sess:::.resolve_endpoint(NULL, path, env_endpoint = "", env_pipe = ""),
      ""
    ),
    "Unsupported session discovery version"
  )
})
