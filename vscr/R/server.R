vscr_app <- function() {
  list(
    # --- HTTP HANDLER (The "Pull" API) ---
    call = function(req) {
      # 1. Authentication Check
      auth_header <- req$HTTP_AUTHORIZATION
      if (is.null(auth_header) || auth_header != .vscr_env$token) {
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
        if (file.exists(.vscr_env$latest_plot_path)) {
          return(list(
            status = 200L,
            headers = list("Content-Type" = "image/png"),
            body = readBin(.vscr_env$latest_plot_path, "raw", file.info(.vscr_env$latest_plot_path)$size)
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
      .vscr_env$ws <- ws
      
      ws$onMessage(function(binary, message) {
        # Handle messages COMING FROM VS Code (e.g., rstudioapi responses)
        payload <- tryCatch(jsonlite::fromJSON(message), error = function(e) NULL)
        
        if (!is.null(payload) && !is.null(payload$type) && payload$type == "rstudioapi_response") {
           # Store response to unblock the wait loop
           .vscr_env$pending_responses[[payload$req_id]] <- payload$data
        }
      })
      
      ws$onClose(function() {
        .vscr_env$ws <- NULL
      })
    }
  )
}