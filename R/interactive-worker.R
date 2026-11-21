function(
  library,
  config,
  support_libraries = NULL,
  managed = TRUE,
  host_library_env = character()
) {
  # Load the bridge explicitly without making its private directory a default
  # install target or changing the library order established by R/renv startup.
  if (
    "sess" %in% loadedNamespaces() &&
      normalizePath(getNamespaceInfo("sess", "path")) != normalizePath(file.path(library, "sess"))
  ) {
    ns <- asNamespace("sess")
    if (exists("interactive_stop", ns, inherits = FALSE)) {
      get("interactive_stop", ns)()
    } else if (exists(".transport_disconnect", ns, inherits = FALSE)) {
      get(".transport_disconnect", ns)(silent = TRUE)
    }
    if ("package:sess" %in% search()) {
      detach("package:sess", unload = FALSE)
    }
    unloadNamespace("sess")
  }
  # Setup installs only missing Imports beside sess. A project such as renv can
  # hide a host installation that satisfied an Import when the bridge was built.
  support_paths <- unique(c(.libPaths(), library, support_libraries))
  host_libraries <- function() {
    if (length(host_library_env)) {
      # renv may have replaced R_LIBS_USER. Restore the agent's library variables
      # only for this child, and restore the project's values even on error.
      set_library_env <- function(values) {
        Sys.unsetenv(names(values)[is.na(values)])
        if (!all(is.na(values))) do.call(Sys.setenv, as.list(values[!is.na(values)]))
      }
      prior <- Sys.getenv(names(host_library_env), unset = NA_character_, names = TRUE)
      on.exit(set_library_env(prior), add = TRUE)
      set_library_env(host_library_env)
    }
    result <- tempfile("vscode-r-host-libraries-")
    on.exit(unlink(result), add = TRUE)
    r <- file.path(R.home("bin"), if (.Platform$OS.type == "windows") "R.exe" else "R")
    status <- system2(
      r,
      c(
        "--vanilla",
        "--slave",
        "-e",
        shQuote("saveRDS(.libPaths(), commandArgs(TRUE)[1L])"),
        "--args",
        shQuote(result)
      ),
      timeout = 15
    )
    if (status != 0L) {
      stop("Could not read the host libraries from ", r)
    }
    readRDS(result)
  }
  load_support <- function(package) {
    tryCatch(
      loadNamespace(package, lib.loc = support_paths),
      error = function(e) {
        if (!is.null(support_libraries)) {
          stop(e)
        }
        support_libraries <<- host_libraries()
        if (all(support_libraries %in% support_paths)) {
          stop(e)
        }
        support_paths <<- unique(c(support_paths, support_libraries))
        loadNamespace(package, lib.loc = support_paths)
      }
    )
  }
  # sess uses qualified calls rather than namespace imports for these packages.
  # processx also calls ps lazily from .onLoad on Linux, before it can finish
  # loading in an isolated renv project.
  for (package in c("jsonlite", "later", "ps", "processx", "rstudioapi")) {
    load_support(package)
  }
  loadNamespace("sess", lib.loc = c(library, support_paths))
  cfg <- jsonlite::fromJSON(config)
  # Prefer project versions of support packages. Libraries outside an isolated
  # project are available only for loading the IDE bridge and its plot device.
  device <- if (isTRUE(cfg$useJgd)) "jgd" else "svglite"
  tryCatch(load_support(device), error = function(e) if (isTRUE(cfg$useJgd)) stop(e))
  sess:::interactive_start(config, managed = managed)
}
