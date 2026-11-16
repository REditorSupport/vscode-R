# Handlers that Interactive publishes to arf with `--ipc-expose`.
#
# arf evaluates the expression after the R profiles and before Interactive loads
# sess from its private library, so this file cannot use sess. Each handler
# finds sess when it is called, and never loads it: loading here or in a handler
# could bring in a different sess from the user's library. A call before
# Interactive has started sess fails with an error instead.
#
# The handlers only forward to `inspection_call()` in sess, which validates the
# arguments, runs the method and encodes the result, all inside the call so that
# the call's execution deadline covers them. The selectors are
# `vscode-r.inspect.json/<method>`; see R/inspection_call.R in sess for the
# contract. The set of methods is fixed here and must match
# `inspection_call_methods` in sess, which the sess tests check.
#
# The file's value is a function of the private library and returns the named
# list for `--ipc-expose`.
function(library) {
  namespace <- "vscode-r.inspect.json"
  methods <- c(
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
  expected <- base::file.path(library, "sess")

  # The namespace of the sess that Interactive started, or an error.
  runtime <- function() {
    # .getNamespace() returns NULL for a namespace that is not loaded, where
    # asNamespace() and loadNamespace() would load it.
    ns <- base::.getNamespace("sess")
    if (base::is.null(ns)) {
      base::stop("The Interactive runtime has not been loaded yet", call. = FALSE)
    }
    same <- base::identical(
      base::normalizePath(base::getNamespaceInfo(ns, "path"), mustWork = FALSE),
      base::normalizePath(expected, mustWork = FALSE)
    )
    if (!same) {
      base::stop("The loaded sess is not the Interactive runtime", call. = FALSE)
    }
    state <- base::get(".sess_env", envir = ns, inherits = FALSE)
    if (!base::isTRUE(state$interactive_connected)) {
      base::stop("The Interactive runtime has not started yet", call. = FALSE)
    }
    ns
  }

  handlers <- base::lapply(methods, function(method) {
    base::force(method)
    function(args) {
      call <- base::get("inspection_call", envir = runtime(), inherits = FALSE)
      call(method, args)
    }
  })
  base::names(handlers) <- base::paste0(namespace, "/", methods)
  handlers
}
