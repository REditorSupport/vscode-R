#' Start the VS Code R IPC Server
#' 
#' @export
sess_app <- function() {
  
  on.exit({
    if (!is.null(.sess_env$server)) {
      notify_vscode("detach", list(pid = Sys.getpid()))
      .sess_env$server$stop()
    }
  })

  # Initialize state
  .sess_env$server <- NULL
  .sess_env$ws <- NULL
  .sess_env$token <- paste0(sample(c(letters, 0:9), 32, replace = TRUE), collapse = "")
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
      if (path == "/workspace" && req$REQUEST_METHOD == "GET") {
        # Lazy workspace evaluation - only done when VS Code asks!
        return(json_response(get_workspace_data()))
      } 
      else if (path == "/plot/latest.png" && req$REQUEST_METHOD == "GET") {
        # Serve plot from memory/temp, not disk syncing
        if (file.exists(.sess_env$latest_plot_path)) {
          return(list(
            status = 200L,
            headers = list("Content-Type" = "image/png"),
            body = readBin(.sess_env$latest_plot_path, "raw", file.info(.sess_env$latest_plot_path)$size)
          ))
        } else {
          return(list(status = 404L, headers = list("Content-Type" = "text/plain"), body = "Plot not found"))
        }
      } 
      else if (path == "/rpc/hover" && req$REQUEST_METHOD == "POST") {
        body <- jsonlite::fromJSON(req$rook.input$read_lines())
        return(json_response(handle_hover(body$expr)))
      }
      else if (path == "/rpc/complete" && req$REQUEST_METHOD == "POST") {
        body <- jsonlite::fromJSON(req$rook.input$read_lines())
        return(json_response(handle_complete(body$expr, body$trigger)))
      }

      list(status = 404L, headers = list("Content-Type" = "text/plain"), body = "Not Found")
    },

    # --- WEBSOCKET HANDLER (The "Push" API) ---
    onWSOpen = function(ws) {
      # Bind the active websocket to our environment
      .sess_env$ws <- ws
      
      # Send the attach handshake immediately upon connection
      notify_vscode("attach", list(
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
        # Handle messages COMING FROM VS Code (e.g., rstudioapi responses)
        payload <- tryCatch(jsonlite::fromJSON(message), error = function(e) NULL)
        
        if (!is.null(payload) && !is.null(payload$type) && payload$type == "rstudioapi_response") {
           # Store response to unblock the wait loop
           .sess_env$pending_responses[[payload$req_id]] <- payload$data
        }
      })
      
      ws$onClose(function() {
        .sess_env$ws <- NULL
      })
    }
  )

  # Start the httpuv server on a random port
  port <- httpuv::randomPort()
  .sess_env$server <- httpuv::startServer("127.0.0.1", port, app = app_handlers)
  
  # Print the connection string to the console.
  cat(sprintf("\n[sess] VSCODE_IPC_SERVER=ws://127.0.0.1:%d?token=%s\n", port, .sess_env$token))
  
  # Register runtime hooks
  register_hooks()
}