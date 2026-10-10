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
        if (!nzchar(bundled_path)) {
            return(invisible(FALSE))
        }

        helper <- Sys.getenv("VSCODE_R_SESS_SOURCE_HELPER", unset = "")
        attach_helper <- Sys.getenv("VSCODE_R_SESS_ATTACH_HELPER", unset = "")
        installer_helper <- Sys.getenv("VSCODE_R_SESS_INSTALLER_HELPER", unset = "")
        managed_root <- Sys.getenv("VSCODE_R_SESS_ROOT", unset = "")
        consent_directory <- Sys.getenv("VSCODE_R_SESS_CONSENT_DIRECTORY", unset = "")
        resources <- c(helper, attach_helper, installer_helper)
        resources_ok <- all(nzchar(c(resources, managed_root))) &&
            all(file.exists(resources))
        if (!resources_ok) {
            message("vscode-R could not locate its sess setup resources; the session watcher was not started.")
            return(invisible(FALSE))
        }
        source(attach_helper, local = TRUE)
        ns <- vscode_r_prepare_sess(bundled_path, managed_root, consent_directory, helper, installer_helper)
        if (is.null(ns)) {
            return(invisible(FALSE))
        }

        plot_backend <- Sys.getenv("SESS_PLOT_BACKEND", "auto")
        connect <- get("connect", envir = ns, inherits = FALSE)
        use_rstudioapi <- as.logical(Sys.getenv("SESS_RSTUDIOAPI", "TRUE"))
        result <- connect(use_rstudioapi = use_rstudioapi, plot_backend = plot_backend)
        isTRUE(result)
    }

    startup_file <- Sys.getenv("VSCODE_R_SESS_STARTUP_FILE", unset = "")
    startup_context <- NULL
    startup_allowed <- TRUE
    if (nzchar(startup_file)) {
        startup_helper <- Sys.getenv("VSCODE_R_SESS_STARTUP_HELPER", unset = "")
        startup_token <- Sys.getenv("VSCODE_R_SESS_STARTUP_TOKEN", unset = "")
        startup_endpoint <- Sys.getenv("VSCODE_R_SESS_STARTUP_ENDPOINT", unset = "")
        if (!nzchar(startup_helper) || !file.exists(startup_helper)) {
            message("vscode-R could not locate its terminal startup notifier; the session watcher was not started.")
            startup_allowed <- FALSE
        } else {
            tryCatch({
                sys.source(startup_helper, envir = environment())
                startup_context <- vscode_r_startup_register(startup_file, startup_token, startup_endpoint)
            }, error = function(error) {
                message("vscode-R could not register terminal startup status: ", conditionMessage(error))
            })
            if (is.null(startup_context)) {
                message("vscode-R could not register terminal startup status; the session watcher was not started.")
                startup_allowed <- FALSE
            }
        }
    }

    if (startup_allowed) {
        tryCatch({
            if (nzchar(startup_file)) {
                vscode_r_startup_run(startup_context, initialize_sess)
            } else {
                initialize_sess()
            }
        }, error = function(error) {
            message("vscode-R could not start the session watcher: ", conditionMessage(error))
            invisible(FALSE)
        }, interrupt = function(error) {
            message("vscode-R session watcher startup was interrupted: ", conditionMessage(error))
            invisible(FALSE)
        })
    }
})
