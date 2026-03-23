#' Start the client R IPC Server
#'
#' @param pipe_path String. The path to use for the pipe server. If NULL, it will use
#'   SESS_SOCKET_PATH env var or a temporary file.
#' @param use_rstudioapi Logical. Should the rstudioapi emulation layer be
#'   enabled? Defaults to TRUE.
#' @param use_httpgd Logical. Should httpgd be used for plotting if available? Defaults to TRUE
#' @export
sess_app <- function(pipe_path = NULL, use_rstudioapi = TRUE, use_httpgd = TRUE) {
  # Initialize state
  .sess_env$server <- NULL
  .sess_env$ws <- NULL

  .sess_env$pending_responses <- list()

  # Specific tempdir for vscode-R
  .sess_env$tempdir <- file.path(tempdir(), "sess")
  dir.create(.sess_env$tempdir, showWarnings = FALSE, recursive = TRUE)

  # Temporary file for static plot serving
  .sess_env$latest_plot_path <- file.path(.sess_env$tempdir, "sess_plot.png")

  app_handlers <- list(
    # --- WEBSOCKET HANDLER ---
    onWSOpen = function(ws) {
      print_async_msg <- function(msg) {
        prompt <- if (interactive()) getOption("prompt") else ""
        cat(sprintf("\r%s\n\n%s", msg, prompt))
      }

      # Bind the active websocket to our environment
      .sess_env$ws <- ws
      print_async_msg("[sess] Client connected")

      # Send the attach handshake immediately upon connection (JSON-RPC Notification)
      notify_client("attach", list(
        version = sprintf("%s.%s", R.version$major, R.version$minor),
        pid = Sys.getpid(),
        tempdir = .sess_env$tempdir,
        wd = getwd(),
        info = list(
          command = commandArgs()[[1L]],
          version = R.version.string,
          start_time = format(Sys.time())
        )
      ))

      ws$onMessage(function(binary, message) {
        # Handle JSON-RPC 2.0 messages COMING FROM the client
        payload <- tryCatch(jsonlite::fromJSON(message), error = function(e) NULL)

        if (!is.null(payload) && !is.null(payload$id)) {
          if (!is.null(payload$method)) {
            # It's a Request from the Client (e.g., 'workspace', 'plot_latest')
            handlers <- list(
              "workspace" = function(p) get_workspace_data(),
              "hover" = function(p) handle_hover(p$expr),
              "completion" = function(p) handle_complete(p$expr, p$trigger),
              "plot_latest" = function(p) handle_plot_latest(p)
            )

            if (payload$method %in% names(handlers)) {
              res <- tryCatch(
                {
                  handlers[[payload$method]](payload$params)
                },
                error = function(e) {
                  # Handle unexpected R errors in handlers
                  warning(sprintf(
                    "[sess] Error in handler for '%s': %s",
                    payload$method, e$message
                  ))
                  NULL
                }
              )

              # Send successful response
              succ_resp <- list(
                jsonrpc = "2.0",
                id = payload$id,
                result = res
              )
              ws$send(jsonlite::toJSON(succ_resp, auto_unbox = TRUE, null = "null", force = TRUE))
            } else {
              # Method not found
              err_resp <- list(
                jsonrpc = "2.0",
                id = payload$id,
                error = list(code = -32601, message = "Method not found")
              )
              ws$send(jsonlite::toJSON(err_resp, auto_unbox = TRUE, null = "null", force = TRUE))
            }
          } else {
            # It's a Response (to our RStudio API request)
            if (!is.null(payload$result)) {
              .sess_env$pending_responses[[as.character(payload$id)]] <-
                payload$result
            } else if (!is.null(payload$error)) {
              .sess_env$pending_responses[[as.character(payload$id)]] <-
                structure(payload$error, class = "json_rpc_error")
            }
          }
        }
      })

      ws$onClose(function() {
        .sess_env$ws <- NULL
        print_async_msg("[sess] Client disconnected")
      })
    }
  )

  # Start the httpuv pipe server
  if (is.null(pipe_path) || is.na(pipe_path)) {
    env_pipe_path <- Sys.getenv("SESS_SOCKET_PATH")
    pipe_path <- if (nzchar(env_pipe_path)) env_pipe_path else tempfile("sess-pipe-")
  }
  .sess_env$server <- httpuv::startPipeServer(pipe_path, mask = strtoi("077", 8), app = app_handlers)

  # Print the connection string to the console.
  cat(sprintf("\n[sess] Server pipe: %s\n\n", pipe_path))

  # Register runtime hooks
  if (is.na(use_rstudioapi)) use_rstudioapi <- TRUE
  if (is.na(use_httpgd)) use_httpgd <- TRUE
  register_hooks(use_rstudioapi = use_rstudioapi, use_httpgd = use_httpgd)

  invisible(NULL)
}
