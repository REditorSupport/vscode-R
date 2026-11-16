# Inspection methods for handler calls published through arf's `--ipc-expose`.
#
# Interactive reaches the same per-method logic through two transports:
#
# - The sess socket runs a request from a `later` callback, where arf does not
#   deliver interrupts, so a slow request cannot be stopped.
# - An arf handler call runs on the R thread under an execution deadline, and
#   arf interrupts the handler when the deadline passes.
#
# Both use the handlers of `inspection_handlers()`. Both resolve `hover` and
# `completion` with `inspection_hover()` and `inspection_completion()`, which
# never evaluate the request text. The socket turns every error into no result,
# while a handler call reports it, so the client can tell an invalid request
# from a failure. Handlers published to arf run outside arf's evaluation policy
# and approval, so they must not accept code from the client.
#
# Contract of the `vscode-r.inspect.json` namespace: a handler takes the method
# parameters as one JSON string, the same object the socket carries as
# `params`, and returns the result as one JSON string. The string is a JSON
# object with `version` and, unless the result is NULL, `result`. Omitting
# `result` for NULL keeps NULL distinct from NA, as in a socket reply. A
# strict-JSON variant that needs no string decoding would use another
# namespace.

inspection_call_namespace <- "vscode-r.inspect.json"

# The only methods that can be called. `interactive_stop` and `plot_latest` stay
# on the socket, and no entry point selects a function by name.
inspection_call_methods <- c(
  "workspace",
  "workspace_children",
  "workspace_view",
  "listview_navigate",
  "listview_view",
  "hover",
  "completion",
  "dataview_init",
  "dataview_page",
  "dataview_dispose"
)

# Encoded results beyond this size would exceed the client's frame limit.
inspection_call_max_bytes <- 4L * 1024L * 1024L

# Per-method logic shared by the socket and handler calls. Each function takes
# the decoded parameters of its request.
inspection_handlers <- function() {
  list(
    workspace = function(p) get_workspace_data(p$revision),
    workspace_children = function(p) get_workspace_children(p$name, p$path, p$start, p$view_id),
    workspace_view = function(p) handle_workspace_view(p$name, p$path),
    listview_navigate = function(p) handle_listview_navigate(p$view_id, p$path),
    listview_view = function(p) handle_listview_view(p$view_id, p$index, p$path),
    dataview_init = function(p) handle_dataview_init(p),
    dataview_page = function(p) handle_dataview_page(p),
    dataview_dispose = function(p) handle_dataview_dispose(p)
  )
}

# The table that handler calls dispatch through, in the order of
# `inspection_call_methods`.
inspection_call_handlers <- function() {
  handlers <- c(
    inspection_handlers(),
    list(
      hover = function(p) inspection_hover(p$expr),
      completion = function(p) inspection_completion(p$expr, p$trigger)
    )
  )
  handlers[inspection_call_methods]
}

# Argument validation. A check returns its value or signals an invalid request.

inspection_check_string <- function(value, name, max_bytes = 100000L) {
  if (
    !is.character(value) ||
      length(value) != 1L ||
      is.na(value) ||
      nchar(value, type = "bytes") > max_bytes
  ) {
    inspection_invalid(sprintf("%s must be a single string", name))
  }
  value
}

inspection_is_number <- function(value) is.numeric(value) && length(value) == 1L && is.finite(value)

inspection_check_number <- function(value, name) {
  if (!inspection_is_number(value)) {
    inspection_invalid(sprintf("%s must be a single finite number", name))
  }
  value
}

inspection_is_index <- function(value) {
  inspection_is_number(value) &&
    value == floor(value) &&
    value >= 1 &&
    value <= .Machine$integer.max
}

inspection_check_index <- function(value, name) {
  if (!inspection_is_index(value)) {
    inspection_invalid(sprintf("%s must be a positive whole number", name))
  }
  value
}

inspection_check_flag <- function(value, name) {
  if (!is.logical(value) || length(value) != 1L || is.na(value)) {
    inspection_invalid(sprintf("%s must be TRUE or FALSE", name))
  }
  value
}

inspection_check_list <- function(value, name) {
  if (!is.list(value)) {
    inspection_invalid(sprintf("%s must be an array or object", name))
  }
  value
}

inspection_max_path <- 10000L

# A path inside a list view: positive item indices.
inspection_check_index_path <- function(value, name) {
  if (!is.list(value) || length(value) > inspection_max_path) {
    inspection_invalid(sprintf("%s must be an array of positive whole numbers", name))
  }
  for (item in value) {
    if (!inspection_is_index(item)) {
      inspection_invalid(sprintf("%s must be an array of positive whole numbers", name))
    }
  }
  value
}

# A path inside a workspace object: selectors of the kinds that
# `workspace_object()` resolves.
inspection_check_selector_path <- function(value, name) {
  if (!is.list(value) || length(value) > inspection_max_path) {
    inspection_invalid(sprintf("%s must be an array of selectors", name))
  }
  for (item in value) {
    kind <- if (is.list(item)) item[["kind"]] else NULL
    selector <- if (is.list(item)) item[["value"]] else NULL
    valid <- is.character(kind) &&
      length(kind) == 1L &&
      !is.na(kind) &&
      if (identical(kind, "index")) {
        inspection_is_index(selector)
      } else if (kind %in% c("name", "slot")) {
        is.character(selector) &&
          length(selector) == 1L &&
          !is.na(selector) &&
          nzchar(selector) &&
          nchar(selector, type = "bytes") <= 10000L
      } else {
        FALSE
      }
    if (!valid) {
      inspection_invalid(sprintf("%s must be an array of selectors", name))
    }
  }
  value
}

# Read an optional parameter. NULL, including a JSON null, means absent.
inspection_param <- function(params, name, check, default = NULL, required = FALSE) {
  value <- params[[name]]
  if (is.null(value)) {
    if (required) {
      inspection_invalid(sprintf("%s is required", name))
    }
    return(default)
  }
  check(value, name)
}

# Validate the parameters of one method, and return only the fields that the
# method reads. Fields that are not validated never reach a handler.
inspection_validate <- function(method, params) {
  string <- inspection_check_string
  number <- inspection_check_number
  index <- inspection_check_index
  one <- function(name, check, ...) inspection_param(params, name, check, ...)
  # Absent fields are omitted rather than set to NULL.
  fields <- function(...) Filter(Negate(is.null), list(...))
  switch(
    method,
    workspace = fields(revision = one("revision", number)),
    workspace_children = {
      view_id <- one("view_id", string)
      name <- one("name", string)
      if (is.null(view_id) && is.null(name)) {
        inspection_invalid("name or view_id is required")
      }
      # A list view is addressed by item indices, a workspace object by selectors.
      path_check <- if (is.null(view_id)) {
        inspection_check_selector_path
      } else {
        inspection_check_index_path
      }
      fields(
        name = name,
        view_id = view_id,
        path = one("path", path_check, default = list()),
        start = one("start", index, default = 1L)
      )
    },
    workspace_view = fields(
      name = one("name", string, required = TRUE),
      path = one("path", inspection_check_selector_path, default = list())
    ),
    listview_navigate = fields(
      view_id = one("view_id", string, required = TRUE),
      path = one("path", inspection_check_index_path, default = list())
    ),
    listview_view = fields(
      view_id = one("view_id", string, required = TRUE),
      path = one("path", inspection_check_index_path, default = list()),
      index = one("index", index, required = TRUE)
    ),
    hover = fields(expr = one("expr", string, required = TRUE)),
    completion = fields(
      expr = one("expr", string, required = TRUE),
      trigger = one("trigger", string)
    ),
    dataview_init = fields(view_id = one("view_id", string, required = TRUE)),
    dataview_page = fields(
      view_id = one("view_id", string, required = TRUE),
      startRow = one("startRow", number),
      endRow = one("endRow", number),
      sortModel = one("sortModel", inspection_check_list),
      filterModel = one("filterModel", inspection_check_list),
      formatNumbers = one("formatNumbers", inspection_check_flag)
    ),
    dataview_dispose = fields(
      view_id = one("view_id", string, required = TRUE),
      state_generation = one("state_generation", number)
    ),
    inspection_invalid("unknown inspection method")
  )
}

# Decode the argument string like `dispatch_message()` decodes a socket line.
inspection_decode <- function(args) {
  if (!is.character(args) || length(args) != 1L || is.na(args)) {
    inspection_invalid("arguments must be one JSON string")
  }
  params <- tryCatch(
    jsonlite::fromJSON(args, simplifyVector = FALSE),
    error = function(e) inspection_invalid("arguments are not valid JSON")
  )
  # An empty JSON object decodes to a named empty list, an array to a list
  # without names.
  if (!is.list(params) || (length(params) > 0L && is.null(names(params)))) {
    inspection_invalid("arguments must be a JSON object")
  }
  params
}

# Encode a result with the socket's settings, as a classless length-1 string.
inspection_encode <- function(result) {
  message <- list(version = 1L)
  # Assigning NULL leaves the field out, as in a socket reply.
  message$result <- result
  json <- enc2utf8(as.character(ipc_json(message)))
  if (nchar(json, type = "bytes") > inspection_call_max_bytes) {
    stop("Inspection result exceeds the size limit", call. = FALSE)
  }
  json
}

# Run one inspection method for a handler call. Decoding, the handler and
# encoding all run here so that an execution deadline covers them. Errors and
# interrupts propagate: arf reports them, and neither becomes a value.
inspection_call <- function(method, args) {
  handlers <- inspection_call_handlers()
  if (!is.character(method) || length(method) != 1L || !method %in% names(handlers)) {
    inspection_invalid("unknown inspection method")
  }
  params <- inspection_validate(method, inspection_decode(args))
  inspection_encode(handlers[[method]](params))
}
