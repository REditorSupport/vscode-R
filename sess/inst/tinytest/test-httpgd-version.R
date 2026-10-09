# Exercise the real backend selection without installing old httpgd binaries.
local({
  sess_env <- sess:::.sess_env
  old_plot_path <- sess_env$latest_plot_path
  sess_env$latest_plot_path <- tempfile(fileext = ".png")
  on.exit({
    sess:::runtime_stop()
    unlink(sess_env$latest_plot_path)
    sess_env$latest_plot_path <- old_plot_path
  })

  env <- new.env(parent = asNamespace("sess"))
  start <- sess:::runtime_start
  environment(start) <- env
  env$requireNamespace <- function(package, ...) {
    identical(package, "httpgd") && !is.null(version)
  }
  env$getNamespaceVersion <- function(package) version
  versions <- list(NULL, "1.2.0", "2.0.0", "2.0.1", "2.1.4", "10.0.0")
  supported <- c(FALSE, FALSE, FALSE, TRUE, TRUE, TRUE)
  for (i in seq_along(versions)) {
    version <- versions[[i]]
    for (backend in c("auto", "httpgd")) {
      warnings <- character()
      withCallingHandlers(
        start(use_rstudioapi = FALSE, plot_backend = backend),
        warning = function(w) {
          warnings <<- c(warnings, conditionMessage(w))
          invokeRestart("muffleWarning")
        }
      )
      expect_equal("sess.plot" %in% getTaskCallbackNames(), !supported[i])
      expect_length(warnings, if (backend == "httpgd" && !supported[i]) 1L else 0L)
      if (length(warnings)) expect_true(grepl("httpgd >= 2.0.1", warnings, fixed = TRUE))
      sess:::runtime_stop()
    }
  }
})
