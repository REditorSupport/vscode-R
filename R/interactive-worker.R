function(library, config, support_libraries = character(), worker = TRUE) {
    # Load the bridge explicitly without making its private directory a default
    # install target or changing the library order established by R/renv startup.
    if ("sess" %in% loadedNamespaces() &&
            normalizePath(getNamespaceInfo("sess", "path")) != normalizePath(file.path(library, "sess"))) {
        ns <- asNamespace("sess")
        if (exists("interactive_stop", ns, inherits = FALSE)) {
            get("interactive_stop", ns)()
        } else if (exists(".transport_disconnect", ns, inherits = FALSE)) {
            get(".transport_disconnect", ns)(silent = TRUE)
        }
        if ("package:sess" %in% search()) detach("package:sess", unload = FALSE)
        unloadNamespace("sess")
    }
    support_paths <- unique(c(.libPaths(), support_libraries))
    # sess uses qualified calls rather than namespace imports for these packages.
    # processx also calls ps lazily from .onLoad on Linux, before it can finish
    # loading in an isolated renv project.
    for (package in c("jsonlite", "later", "ps", "processx", "rstudioapi")) {
        loadNamespace(package, lib.loc = support_paths)
    }
    loadNamespace("sess", lib.loc = c(library, support_paths))
    cfg <- jsonlite::fromJSON(config)
    # Prefer project versions of support packages. Libraries outside an isolated
    # project are available only for loading the IDE bridge and its plot device.
    device <- if (isTRUE(cfg$useJgd)) "jgd" else "svglite"
    tryCatch(loadNamespace(device, lib.loc = support_paths),
             error = function(e) {
                 if (isTRUE(cfg$useJgd)) stop(e)
             })
    if (worker) sess::run_worker(config) else sess::interactive_start(config, mirror = TRUE)
}
