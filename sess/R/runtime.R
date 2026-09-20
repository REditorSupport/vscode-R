# Runtime state is deliberately independent from the IPC connection state.
.runtime_empty_diagnostics <- function() {
  list(
    workspace_callback_entries = 0L,
    workspace_notify_attempts = 0L,
    workspace_notify_sent = 0L,
    plot_callback_entries = 0L,
    plot_notify_attempts = 0L,
    plot_notify_sent = 0L
  )
}

.runtime_state <- function() {
  if (is.null(.sess_env$runtime)) {
    state <- new.env(parent = emptyenv())
    state$active <- FALSE
    state$options <- list()
    state$bindings <- list()
    state$hooks <- list()
    state$s3_methods <- list()
    state$task_callbacks <- list()
    state$devices <- list()
    state$fields <- list()
    state$diagnostics <- .runtime_empty_diagnostics()
    .sess_env$runtime <- state
  }
  .sess_env$runtime
}

.runtime_diagnostic_increment <- function(name) {
  state <- .runtime_state()
  state$diagnostics[[name]] <- state$diagnostics[[name]] + 1L
  invisible(state$diagnostics[[name]])
}

.runtime_clear_viewer_state <- function() {
  # Open dataviews and title-to-id mappings belong to one runtime connection.
  # Keep an empty registry available, but never restore data from a prior run.
  .sess_env$dataviews <- list()
  .sess_env$dataview_registry <- new.env(parent = emptyenv())
  invisible(NULL)
}

.runtime_set_field <- function(name, value) {
  state <- .runtime_state()
  index <- which(vapply(state$fields, function(entry) identical(entry$name, name), logical(1)))
  if (!length(index)) {
    exists_original <- exists(name, envir = .sess_env, inherits = FALSE)
    original <- if (exists_original) get(name, envir = .sess_env, inherits = FALSE) else NULL
    state$fields[[length(state$fields) + 1L]] <- list(
      name = name,
      original_exists = exists_original,
      original = original
    )
    index <- length(state$fields)
  }
  assign(name, value, envir = .sess_env)
  state$fields[[index[[1L]]]]$installed_exists <- exists(name, envir = .sess_env, inherits = FALSE)
  state$fields[[index[[1L]]]]$installed <- if (state$fields[[index[[1L]]]]$installed_exists) {
    get(name, envir = .sess_env, inherits = FALSE)
  } else {
    NULL
  }
  invisible(value)
}

.runtime_set_option <- function(name, value) {
  state <- .runtime_state()
  if (is.null(state$options[[name]])) {
    state$options[[name]] <- list(original = getOption(name))
  }
  do.call(options, setNames(list(value), name))
  state$options[[name]]$installed <- getOption(name)
  invisible(value)
}

.runtime_assign_binding <- function(sym, value, env) {
  locked <- bindingIsLocked(sym, env)
  if (locked) unlockBinding(sym, env)
  on.exit({
    if (locked && exists(sym, envir = env, inherits = FALSE) &&
          !bindingIsLocked(sym, env)) {
      lockBinding(sym, env)
    }
  }, add = TRUE)
  assign(sym, value, envir = env)
  invisible(value)
}

.runtime_rebind <- function(sym, value, ns) {
  envs <- if (is.character(ns)) {
    namespace <- asNamespace(ns)
    attached <- paste0("package:", ns)
    if (attached %in% search()) {
      c(list(namespace), list(as.environment(attached)))
    } else {
      list(namespace)
    }
  } else if (is.environment(ns)) {
    list(ns)
  } else {
    stop("ns must be a string or environment")
  }

  state <- .runtime_state()
  for (env in envs) {
    if (!exists(sym, envir = env, inherits = FALSE)) next
    index <- which(vapply(state$bindings, function(entry) {
      identical(entry$env, env) && identical(entry$name, sym)
    }, logical(1)))
    if (!length(index)) {
      state$bindings[[length(state$bindings) + 1L]] <- list(
        env = env,
        name = sym,
        original = get(sym, envir = env, inherits = FALSE),
        installed = value,
        locked = bindingIsLocked(sym, env)
      )
    } else {
      state$bindings[[index[[1L]]]]$installed <- value
    }

    .runtime_assign_binding(sym, value, env)
  }
  invisible(value)
}

.runtime_set_hook <- function(name, value, action = "replace") {
  state <- .runtime_state()
  current <- getHook(name)
  index <- which(vapply(state$hooks, function(entry) identical(entry$name, name), logical(1)))
  if (!length(index)) {
    state$hooks[[length(state$hooks) + 1L]] <- list(name = name, original = current)
    index <- length(state$hooks)
  }
  setHook(name, value, action = action)
  state$hooks[[index[[1L]]]]$installed <- getHook(name)
  state$hooks[[index[[1L]]]]$added <- value
  invisible(NULL)
}

.runtime_s3_dispatch_env <- function(generic, envir) {
  generic_function <- try(get(generic, envir = envir), silent = TRUE)
  if (inherits(generic_function, "try-error") || !is.function(generic_function)) {
    return(envir)
  }
  generic_envir <- environment(generic_function)
  if (is.null(generic_envir)) envir else generic_envir
}

.runtime_register_s3 <- function(generic, class, method, envir) {
  state <- .runtime_state()
  registration_envir <- new.env(parent = envir)
  dispatch_envir <- .runtime_s3_dispatch_env(generic, envir)
  original <- utils::getS3method(generic, class, envir = dispatch_envir,
                                 optional = TRUE)
  original_namespace_methods <- if (isNamespace(envir)) {
    getNamespaceInfo(envir, "S3methods")
  } else {
    NULL
  }
  registerS3method(generic, class, method, envir = registration_envir)
  state$s3_methods[[length(state$s3_methods) + 1L]] <- list(
    generic = generic,
    class = class,
    envir = registration_envir,
    namespace_envir = envir,
    dispatch_envir = dispatch_envir,
    original = original,
    installed = method,
    original_namespace_methods = original_namespace_methods,
    installed_namespace_methods = if (isNamespace(envir)) {
      getNamespaceInfo(envir, "S3methods")
    } else {
      NULL
    }
  )
  invisible(method)
}

.runtime_add_task_callback <- function(fun, name) {
  state <- .runtime_state()
  addTaskCallback(fun, name = name)
  state$task_callbacks[[length(state$task_callbacks) + 1L]] <- name
  invisible(name)
}

.runtime_track_device <- function(id = grDevices::dev.cur()) {
  state <- .runtime_state()
  devices <- grDevices::dev.list()
  if (is.null(devices)) return(invisible(NULL))
  name <- names(devices)[match(id, devices)]
  if (length(name) && !is.na(name)) {
    state$devices[[length(state$devices) + 1L]] <- list(
      id = unname(id),
      name = name
    )
  }
  invisible(id)
}

.runtime_restore <- function() {
  state <- .runtime_state()

  for (name in rev(state$task_callbacks)) {
    try(removeTaskCallback(name), silent = TRUE)
  }
  state$task_callbacks <- list()

  for (entry in rev(state$s3_methods)) {
    current <- utils::getS3method(
      entry$generic,
      entry$class,
      envir = entry$dispatch_envir,
      optional = TRUE
    )
    restore_namespace_methods <- isNamespace(entry$namespace_envir) &&
      identical(getNamespaceInfo(entry$namespace_envir, "S3methods"),
                entry$installed_namespace_methods)

    if (identical(current, entry$installed)) {
      if (!is.null(entry$original)) {
        try(registerS3method(entry$generic, entry$class, entry$original,
                             envir = entry$envir), silent = TRUE)
      } else {
        dispatch_env <- entry$dispatch_envir
        table <- get0(".__S3MethodsTable__.", envir = dispatch_env, inherits = FALSE)
        method_name <- paste(entry$generic, entry$class, sep = ".")
        if (is.environment(table) &&
              exists(method_name, envir = table, inherits = FALSE) &&
              identical(get(method_name, envir = table, inherits = FALSE), entry$installed)) {
          rm(list = method_name, envir = table)
        }
      }
    }
    if (restore_namespace_methods) {
      try(
        setNamespaceInfo(entry$namespace_envir, "S3methods",
                         entry$original_namespace_methods),
        silent = TRUE
      )
    }
  }
  state$s3_methods <- list()

  for (entry in rev(state$hooks)) {
    current <- getHook(entry$name)
    if (identical(current, entry$installed)) {
      try(setHook(entry$name, entry$original, action = "replace"), silent = TRUE)
    } else if (!is.null(entry$added)) {
      # Keep hooks installed by other code while removing only our own callback.
      current <- Filter(function(hook) !identical(hook, entry$added), current)
      try(setHook(entry$name, current, action = "replace"), silent = TRUE)
    }
  }
  state$hooks <- list()

  for (entry in rev(state$bindings)) {
    env <- entry$env
    name <- entry$name
    if (exists(name, envir = env, inherits = FALSE) &&
          identical(get(name, envir = env, inherits = FALSE), entry$installed)) {
      try(.runtime_assign_binding(name, entry$original, env), silent = TRUE)
    }
  }
  state$bindings <- list()

  # Close devices opened through sess's device factory so plotting resumes on
  # the device R selects after the runtime-owned device is removed.
  for (entry in rev(state$devices)) {
    devices <- grDevices::dev.list()
    index <- if (is.null(devices)) NA_integer_ else match(entry$id, devices)
    if (!is.na(index) && identical(names(devices)[[index]], entry$name)) {
      try(grDevices::dev.off(which = entry$id), silent = TRUE)
    }
  }
  state$devices <- list()

  for (entry in rev(state$fields)) {
    exists_current <- exists(entry$name, envir = .sess_env, inherits = FALSE)
    current <- if (exists_current) get(entry$name, envir = .sess_env, inherits = FALSE) else NULL
    if (identical(exists_current, entry$installed_exists) &&
          (!exists_current || identical(current, entry$installed))) {
      if (entry$original_exists) {
        assign(entry$name, entry$original, envir = .sess_env)
      } else if (exists_current) {
        rm(list = entry$name, envir = .sess_env)
      }
    }
  }
  state$fields <- list()

  for (name in names(state$options)) {
    entry <- state$options[[name]]
    if (identical(getOption(name), entry$installed)) {
      try(do.call(options, setNames(list(entry$original), name)), silent = TRUE)
    }
  }
  state$options <- list()
  .runtime_clear_viewer_state()
  state$active <- FALSE
  invisible(NULL)
}

#' Stop the VS Code runtime integration (internal)
#'
#' Removes runtime callbacks and restores R state installed by runtime_start().
#' @keywords internal
runtime_stop <- function() {
  state <- .runtime_state()
  if (!isTRUE(state$active) && !length(state$options) &&
        !length(state$bindings) && !length(state$hooks) &&
        !length(state$s3_methods) && !length(state$task_callbacks) &&
        !length(state$devices) && !length(state$fields)) {
    .runtime_clear_viewer_state()
    return(invisible(NULL))
  }
  # Prevent callbacks from sending new notifications during cleanup.
  state$active <- FALSE
  .runtime_restore()
}
