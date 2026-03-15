# Helper to format JSON-RPC 2.0 Responses
json_rpc_response <- function(id, result) {
  list(
    status = 200L,
    headers = list("Content-Type" = "application/json"),
    body = jsonlite::toJSON(list(
      jsonrpc = "2.0",
      id = id,
      result = result
    ), auto_unbox = TRUE, null = "null", force = TRUE)
  )
}

# Helper to format JSON-RPC 2.0 Errors
json_rpc_error <- function(id, code, message, data = NULL) {
  list(
    status = 200L, # JSON-RPC typically returns 200 even for errors
    headers = list("Content-Type" = "application/json"),
    body = jsonlite::toJSON(list(
      jsonrpc = "2.0",
      id = id,
      error = list(
        code = code,
        message = message,
        data = data
      )
    ), auto_unbox = TRUE, null = "null", force = TRUE)
  )
}

# Helper to safely hijack and override R internal functions
rebind <- function(sym, value, ns) {
  if (is.character(ns)) {
    Recall(sym, value, getNamespace(ns))
    pkg <- paste0("package:", ns)
    if (pkg %in% search()) {
      Recall(sym, value, as.environment(pkg))
    }
  } else if (is.environment(ns)) {
    if (bindingIsLocked(sym, ns)) {
      unlockBinding(sym, ns)
      on.exit(lockBinding(sym, ns))
    }
    assign(sym, value, ns)
  } else {
    stop("ns must be a string or environment")
  }
}
