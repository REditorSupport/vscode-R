# Connection messages do not reprint a prompt, and sess.quiet suppresses only success.
local({
  if (!requireNamespace("processx", quietly = TRUE) || .Platform$OS.type == "windows") {
    return(invisible(NULL))
  }

  old_options <- options()[c("sess.quiet", "prompt")]
  on.exit({
    options(old_options)
    sess:::.transport_disconnect(silent = TRUE)
  }, add = TRUE)

  connect_once <- function(quiet) {
    path <- tempfile(fileext = ".sock")
    server <- processx::conn_create_unix_socket(path, encoding = "")
    on.exit({
      sess:::.transport_disconnect(silent = TRUE)
      try(close(server), silent = TRUE)
      unlink(path)
    }, add = TRUE)

    options(sess.quiet = quiet)
    capture.output(sess::connect(
      endpoint = path,
      use_rstudioapi = FALSE,
      use_httpgd = FALSE,
      use_jgd = FALSE
    ))
  }

  options(prompt = "custom prompt> ")
  visible <- connect_once(FALSE)
  expect_true(any(grepl("\\[sess\\] Connected to VS Code", visible)))
  expect_false(any(grepl("custom prompt>", visible, fixed = TRUE)))

  quiet <- connect_once(TRUE)
  expect_length(quiet, 0L)

  missing <- tempfile(fileext = ".sock")
  failure <- capture.output(sess::connect(
    endpoint = missing,
    use_rstudioapi = FALSE,
    use_httpgd = FALSE,
    use_jgd = FALSE
  ))
  expect_true(any(grepl("\\[sess\\] Failed to connect", failure)))
})
