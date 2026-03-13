#' Start the client R IPC Server
#'
#' @param use_rstudioapi Logical. Should the rstudioapi emulation layer be enabled? Defaults to TRUE.
#' @param use_httpgd Logical. Should httpgd be used for plotting if available? Defaults to TRUE
#' @export
sess_app <- function(use_rstudioapi = TRUE, use_httpgd = TRUE) {
  # Initialize state
  .sess_env$server <- NULL
  .sess_env$ws <- NULL

  env_token <- Sys.getenv("SESS_TOKEN")
  .sess_env$token <- if (nzchar(env_token)) env_token else paste0(sample(c(letters, 0:9), 32, replace = TRUE), collapse = "")
  .sess_env$pending_responses <- list()

  # Temporary file for static plot serving
  .sess_env$latest_plot_path <- file.path(tempdir(), "sess_plot.png")

  app_handlers <- list(
    # --- HTTP HANDLER (The "Pull" API) ---
    call = function(req) {
      # 1. Authentication Check
      auth_header <- req$HTTP_AUTHORIZATION
      if (is.null(auth_header) || auth_header != .sess_env$token) {
        return(list(status = 401L, headers = list("Content-Type" = "text/plain"), body = "Unauthorized"))
      }

      path <- req$PATH_INFO

      # 2. Routing
      if (path == "/rpc" && req$REQUEST_METHOD == "POST") {
        # JSON-RPC 2.0 Implementation
        body <- tryCatch(jsonlite::fromJSON(req$rook.input$read_lines()), error = function(e) NULL)

        if (is.null(body) || is.null(body$method)) {
          return(json_rpc_error(NULL, -32600, "Invalid Request"))
        }

        # Dispatch method
        res <- switch(body$method,
          "workspace" = get_workspace_data(),
          "hover" = handle_hover(body$params$expr),
          "completion" = handle_complete(body$params$expr, body$params$trigger),
          "plot_latest" = {
            if (file.exists(.sess_env$latest_plot_path)) {
              raw_img <- readBin(.sess_env$latest_plot_path, "raw", file.info(.sess_env$latest_plot_path)$size)
              list(data = as.character(jsonlite::base64_enc(raw_img)))
            } else {
              list(data = NULL)
            }
          },
          NULL
        )

        if (is.null(res)) {
          return(json_rpc_error(body$id, -32601, "Method not found"))
        }

        return(json_rpc_response(body$id, res))
      }

      list(status = 404L, headers = list("Content-Type" = "text/plain"), body = "Not Found")
    },

    # --- WEBSOCKET HANDLER (The "Push" API) ---
    onWSOpen = function(ws) {
      # Bind the active websocket to our environment
      .sess_env$ws <- ws

      # Send the attach handshake immediately upon connection (JSON-RPC Notification)
      notify_client("attach", list(
        version = sprintf("%s.%s", R.version$major, R.version$minor),
        pid = Sys.getpid(),
        tempdir = tempdir(),
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
          # It's a Response (to our RStudio API request)
          if (!is.null(payload$result)) {
            .sess_env$pending_responses[[as.character(payload$id)]] <- payload$result
          } else if (!is.null(payload$error)) {
            .sess_env$pending_responses[[as.character(payload$id)]] <- structure(payload$error, class = "json_rpc_error")
          }
        }
      })

      ws$onClose(function() {
        .sess_env$ws <- NULL
      })
    }
  )

  # Start the httpuv server on a specific or random port
  env_port <- Sys.getenv("SESS_PORT")
  port <- if (nzchar(env_port)) as.integer(env_port) else httpuv::randomPort()
  .sess_env$server <- httpuv::startServer("127.0.0.1", port, app = app_handlers)

  # Print the connection string to the console.
  # We use OSC 633;P;SessConnection=... to announce the connection to the terminal
  # This is hidden in modern terminals but can be parsed by the extension.
  cat(sprintf("\x1b]633;P;SessConnection=ws://127.0.0.1:%d?token=%s\x07", port, .sess_env$token))
  cat(sprintf("\n[sess] SESS_IPC_SERVER=ws://127.0.0.1:%d?token=%s\n", port, .sess_env$token))

  # Register runtime hooks
  register_hooks(use_rstudioapi = use_rstudioapi, use_httpgd = use_httpgd)
}
