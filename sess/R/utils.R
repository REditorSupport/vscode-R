# Helper to format HTTP JSON responses
json_response <- function(data) {
  list(
    status = 200L,
    headers = list("Content-Type" = "application/json"),
    body = jsonlite::toJSON(data, auto_unbox = TRUE, null = "null", force = TRUE)
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