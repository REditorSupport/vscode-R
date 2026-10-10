# Source the original .Rprofile
local({
    try_source <- function(file) {
        if (file.exists(file)) {
            source(file)
            TRUE
        } else {
            FALSE
        }
    }

    r_profile <- Sys.getenv("R_PROFILE_USER_OLD")
    Sys.setenv(
        R_PROFILE_USER_OLD = "",
        R_PROFILE_USER = r_profile
    )

    if (nzchar(r_profile)) {
        try_source(r_profile)
    } else {
        try_source(".Rprofile") || try_source(file.path("~", ".Rprofile"))
    }

    invisible()
})

local({
    initialize_sess <- function() {
        bundled_path <- Sys.getenv("VSCODE_R_SESS_PKG_PATH", unset = "")
        if (!nzchar(bundled_path)) return(invisible(NULL))

        helper <- Sys.getenv("VSCODE_R_SESS_SOURCE_HELPER", unset = "")
        if (!nzchar(helper) || !file.exists(helper)) {
            message("vscode-R could not locate its sess source verifier; the session watcher was not started.")
            return(invisible(NULL))
        }
        source(helper, local = TRUE)
        expected <- sess_source_revision(file.path(bundled_path, "DESCRIPTION"))
        if (is.null(expected)) {
            message("Bundled sess has no valid source revision; the session watcher was not started.")
            return(invisible(NULL))
        }

        loaded_revision <- sess_loaded_source_revision()
        if ("sess" %in% loadedNamespaces()) {
            if (!identical(loaded_revision, expected)) {
                stop("A different sess namespace is already loaded. Restart R so vscode-R can attach the session watcher.")
            }
            library <- dirname(getNamespaceInfo(asNamespace("sess"), "path"))
        } else {
            library <- sess_find_source_library(expected, .libPaths())
            if (is.null(library)) {
                managed_root <- Sys.getenv("VSCODE_R_SESS_ROOT", unset = "")
                managed_library <- if (nzchar(managed_root)) sess_managed_library(managed_root, expected) else ""
                if (!nzchar(managed_library) ||
                        !identical(sess_installed_source_revision(managed_library), expected)) {
                    message("The bundled sess required by vscode-R is unavailable. The R session started without the session watcher.")
                    return(invisible(NULL))
                }
                library <- managed_library
            }
            sess_load_namespace(library, expected)
        }

        plot_backend <- Sys.getenv("SESS_PLOT_BACKEND", "auto")
        getExportedValue("sess", "connect")(
            use_rstudioapi = as.logical(Sys.getenv("SESS_RSTUDIOAPI", "TRUE")),
            plot_backend = plot_backend
        )
    }
    tryCatch(initialize_sess(), error = function(error) {
        message("vscode-R could not start the session watcher: ", conditionMessage(error))
    })
})
