.vscr_env <- new.env(parent = emptyenv())

.onLoad <- function(libname, pkgname) {
  # Initialize state
  .vscr_env$server <- NULL
  .vscr_env$ws <- NULL
  .vscr_env$token <- paste0(sample(c(letters, 0:9), 32, replace = TRUE), collapse = "")
  .vscr_env$pending_responses <- list()
  
  # Temporary file for static plot serving
  .vscr_env$latest_plot_path <- file.path(tempdir(), "vscr_plot.png")
  
  # Start the httpuv server on a random port
  port <- httpuv::randomPort()
  .vscr_env$server <- httpuv::startServer("127.0.0.1", port, app = vscr_app())
  
  # Print the connection string to the console.
  # The VS Code extension's terminal tracker intercepts this to connect the WebSocket.
  cat(sprintf("\n[vscr] VSCODE_IPC_SERVER=ws://127.0.0.1:%d?token=%s\n", port, .vscr_env$token))
  
  # Register runtime hooks
  register_hooks()
}

.onUnload <- function(libpath) {
  if (!is.null(.vscr_env$server)) {
    notify_vscode("detach", list(pid = Sys.getpid()))
    .vscr_env$server$stop()
  }
}