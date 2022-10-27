add_lib_paths <- Sys.getenv("VSCR_LIB_PATHS")
if (nzchar(add_lib_paths)) {
  add_lib_paths <- strsplit(add_lib_paths, "\n", fixed = TRUE)[[1L]]
  .libPaths(c(.libPaths(), add_lib_paths))
}

if (!requireNamespace("languageserver", quietly = TRUE)) {
  q(save = "no", status = 10)
}

debug <- Sys.getenv("VSCR_LSP_DEBUG")
port <- Sys.getenv("VSCR_LSP_PORT")

debug <- if (nzchar(debug)) as.logical(debug) else FALSE
port <- if (nzchar(port)) as.integer(port) else NULL

languageserver::run(port = port, debug = debug)
