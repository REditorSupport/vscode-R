# Hover and completion targets that editors may request without evaluating code.
#
# Requests carry the text in front of the cursor (for example `x`, `df$col`, or
# `obj@slot`). The text is parsed but never evaluated. It is accepted only when
# it is a single name, a single constant, or a chain of `$` and `@` accesses on
# a name, and is then resolved by looking the name up and applying fixed
# accessor operations.
#
# Why requests must not evaluate arbitrary expressions:
# - These handlers can be exposed to other clients, for example as arf IPC
#   handlers. arf runs exposed handlers outside its evaluation policy and
#   outside the human approval it requires for visible evaluation, so a handler
#   that evaluates an expression would let any client of the same user run
#   arbitrary code without that approval.
# - Hover and completion run without an explicit user action, so evaluating an
#   expression would run code just because the cursor moved or `$` was typed.
#   R's own completion (utils rcompgen) likewise does not evaluate a prefix
#   that contains an explicit function call, and IPython limits completion to
#   side-effect-free evaluation by default.
#
# Constants are accepted because evaluating them runs no code, and the editor
# already requests hover for them.
#
# Not evaluating the request does not make inspection free of side effects:
# promises, active bindings, S3 `$` methods, and methods of `str()` or
# `.DollarNames()` run code that is already defined in the session. They are
# kept so that hover and completion keep working for lazy data, R6 objects and
# classes with custom accessors.

inspection_invalid <- function(message) {
  stop(structure(
    class = c("sess_inspection_invalid", "error", "condition"),
    list(message = message, call = NULL)
  ))
}

inspection_is_constant <- function(expr) {
  is.null(expr) || (is.atomic(expr) && length(expr) == 1L && is.null(attributes(expr)))
}

inspection_is_name <- function(expr) {
  # `...` and `..1` are not bindings that can be looked up by name.
  is.symbol(expr) && !grepl("^\\.\\.(\\.|[0-9]+)$", as.character(expr))
}

# Parse a request into list(root, path) without evaluating it.
#
# Parsing is done in R so that the accepted syntax, such as numeric literals
# and spacing around `$`, matches R exactly and is validated in one place.
inspection_target <- function(expr) {
  if (!is.character(expr) || length(expr) != 1L || is.na(expr)) {
    inspection_invalid("expr must be a single string")
  }
  exprs <- tryCatch(
    parse(text = expr, keep.source = FALSE),
    error = function(e) inspection_invalid("expr is not valid R syntax")
  )
  # Earlier versions evaluated only the first of several expressions.
  if (length(exprs) != 1L) {
    inspection_invalid("expr must be a single expression")
  }
  node <- exprs[[1L]]
  if (inspection_is_constant(node)) {
    return(list(root = list(kind = "constant", value = node), path = list()))
  }
  path <- list()
  while (is.call(node)) {
    operator <- node[[1L]]
    if (
      length(node) != 3L || !(identical(operator, quote(`$`)) || identical(operator, quote(`@`)))
    ) {
      inspection_invalid("expr must be a name or a chain of $ and @ accesses")
    }
    member <- node[[3L]]
    if (is.symbol(member)) {
      member <- as.character(member)
    } else if (!is.character(member) || length(member) != 1L || is.na(member)) {
      inspection_invalid("$ and @ must be followed by a name")
    }
    path <- c(list(list(operator = as.character(operator), name = member)), path)
    node <- node[[2L]]
  }
  if (!inspection_is_name(node)) {
    inspection_invalid("expr must start with a name")
  }
  list(root = list(kind = "name", name = as.character(node)), path = path)
}

# Apply one accessor with the base operator, regardless of any `$` or `@`
# defined in the global environment.
#
# The operators do not evaluate their member argument, so the call is built
# with the member as a symbol. The operator is embedded as a function object so
# that masking definitions are not looked up, and the object is bound in a
# private environment so that it is never re-evaluated. The environment's
# parent is the global environment so that S3 methods defined there still
# dispatch, as they would for `x$name` typed at the console. `@` is used rather
# than methods::slot() so that its own dispatch (S4 slots, S7 properties) is
# kept.
inspection_access <- function(object, operator, name) {
  if (operator == "$" && is.atomic(object) && !is.object(object)) {
    # A plain vector has no members; `$` would signal an error.
    return(list(found = FALSE))
  }
  if (operator == "@") {
    if (isS4(object) && !methods::.hasSlot(object, name)) {
      return(list(found = FALSE))
    }
    if (!isS4(object) && !is.object(object)) {
      return(list(found = FALSE))
    }
  }
  fun <- if (operator == "$") base::`$` else base::`@`
  env <- new.env(parent = .GlobalEnv)
  assign(".object", object, envir = env)
  value <- eval(as.call(list(fun, as.name(".object"), as.name(name))), env)
  list(found = TRUE, value = value)
}

# Resolve a parsed target to list(found, value). Each step reads its binding
# once, so an active binding or promise on the path runs at most once.
# Errors and interrupts from the session's own code are not caught.
inspection_resolve <- function(target) {
  root <- target$root
  if (identical(root$kind, "constant")) {
    return(list(found = TRUE, value = root$value))
  }
  # exists() does not force promises or call active bindings.
  if (!exists(root$name, envir = .GlobalEnv, inherits = TRUE)) {
    return(list(found = FALSE))
  }
  object <- get(root$name, envir = .GlobalEnv, inherits = TRUE)
  for (step in target$path) {
    result <- inspection_access(object, step$operator, step$name)
    if (!isTRUE(result$found)) {
      return(result)
    }
    object <- result$value
  }
  list(found = TRUE, value = object)
}

# Hover text for a request, or NULL when nothing is found. Invalid requests
# signal a `sess_inspection_invalid` error.
inspection_hover <- function(expr) {
  resolved <- inspection_resolve(inspection_target(expr))
  if (!isTRUE(resolved$found)) {
    return(NULL)
  }
  list(str = capture_str(resolved$value))
}

# Completion items after `$` or `@`, or NULL when nothing is found.
inspection_completion <- function(expr, trigger = NULL) {
  if (!is.null(trigger) && (!is.character(trigger) || length(trigger) != 1L || is.na(trigger))) {
    inspection_invalid("trigger must be a single string")
  }
  resolved <- inspection_resolve(inspection_target(expr))
  if (!isTRUE(resolved$found)) {
    return(NULL)
  }
  completion_items(resolved$value, trigger)
}
