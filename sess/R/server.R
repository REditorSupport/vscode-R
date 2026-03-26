#' Start the client R IPC connection
#'
#' @param port Integer. The port of the VS Code WebSocket server.
#'   If NULL, it will use SESS_PORT env var.
#' @param token String. The authentication token. If NULL, it will use SESS_TOKEN env var.
#' @param use_rstudioapi Logical. Should the rstudioapi emulation layer
#'   be enabled? Defaults to TRUE.
#' @param use_httpgd Logical. Should httpgd be used for plotting if available? Defaults to TRUE
#' @export
sess_app <- function(port = NULL, token = NULL, use_rstudioapi = TRUE, use_httpgd = TRUE) {
  # Initialize state
  .sess_env$server <- NULL
  .sess_env$ws <- NULL
  .sess_env$pending_responses <- list()

  # Specific tempdir for vscode-R
  .sess_env$tempdir <- file.path(tempdir(), "sess")
  dir.create(.sess_env$tempdir, showWarnings = FALSE, recursive = TRUE)

  # Temporary file for static plot serving
  .sess_env$latest_plot_path <- file.path(.sess_env$tempdir, "sess_plot.png")

  if (is.null(port) || is.na(port)) {
    port <- Sys.getenv("SESS_PORT")
  }
  if (is.null(token) || is.na(token) || !nzchar(token)) {
    token <- Sys.getenv("SESS_TOKEN")
  }

  if (!nzchar(port) || !nzchar(token)) {
    warning("[sess] SESS_PORT or SESS_TOKEN not set. Cannot connect to VS Code.")
    return(invisible(NULL))
  }

  print_async_msg <- function(msg) {
    prompt <- if (interactive()) getOption("prompt") else ""
    cat(sprintf("\r%s\n\n%s", msg, prompt))
  }

  url <- sprintf("ws://127.0.0.1:%s/?token=%s", port, token)
  ws <- websocket::WebSocket$new(url, autoConnect = FALSE)

  ws$onOpen(function(event) {
    .sess_env$ws <- ws
    print_async_msg("[sess] Connected to VS Code")

    # Send the attach handshake immediately upon connection
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
  })

  ws$onMessage(function(event) {
    # Handle JSON-RPC 2.0 messages COMING FROM the client
    payload <- tryCatch(jsonlite::fromJSON(event$data), error = function(e) NULL)

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
              warning(sprintf(
                "[sess] Error in handler for '%s': %s",
                payload$method, e$message
              ))
              NULL
            }
          )

          succ_resp <- list(
            jsonrpc = "2.0",
            id = payload$id,
            result = res
          )
          ws$send(jsonlite::toJSON(succ_resp, auto_unbox = TRUE, null = "null", force = TRUE))
        } else {
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

  ws$onClose(function(event) {
    .sess_env$ws <- NULL
    print_async_msg("[sess] Disconnected from VS Code")
  })

  ws$onError(function(event) {
    print_async_msg(sprintf("[sess] WebSocket error: %s", event$message))
  })

  # Connect to VS Code
  ws$connect()

  # Register runtime hooks
  if (is.na(use_rstudioapi)) use_rstudioapi <- TRUE
  if (is.na(use_httpgd)) use_httpgd <- TRUE
  register_hooks(use_rstudioapi = use_rstudioapi, use_httpgd = use_httpgd)

  invisible(NULL)
}
