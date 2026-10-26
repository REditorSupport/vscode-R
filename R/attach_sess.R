# Shared terminal and manual-attach preparation. Installation requires a
# single-use grant from the extension process; .libPaths() is never changed.

# Source the tool preparation helper into a fresh environment. Returns NULL
# after reporting the failure when it cannot be loaded.
vscode_r_load_prepare_helper <- function(helper, package) {
    setup <- new.env(parent = environment(vscode_r_load_prepare_helper))
    loaded <- nzchar(helper) && file.exists(helper) &&
        isTRUE(tryCatch({
            sys.source(helper, envir = setup)
            TRUE
        }, error = function(error) {
            message("vscode-R could not load managed ", package, " setup resources: ",
                    conditionMessage(error))
            FALSE
        }))
    if (loaded) setup else NULL
}

vscode_r_with_jgd <- function(
    plot_backend,
    connect,
    tool_prepare_helper = Sys.getenv("VSCODE_R_TOOL_PREPARE_HELPER", unset = ""),
    tool_root = Sys.getenv("VSCODE_R_TOOL_ROOT", unset = ""),
    tool_consent_directory = Sys.getenv("VSCODE_R_TOOL_CONSENT_DIRECTORY", unset = ""),
    tool_library_helper = Sys.getenv("VSCODE_R_TOOL_LIBRARY_HELPER", unset = ""),
    tool_consent_helper = Sys.getenv("VSCODE_R_TOOL_CONSENT_HELPER", unset = ""),
    can_prompt = identical(Sys.getenv("VSCODE_R_JGD_CAN_PROMPT", unset = "TRUE"), "TRUE"),
    minimum_version = Sys.getenv("VSCODE_R_JGD_MINIMUM_VERSION", unset = "")
) {
    if (!is.function(connect)) stop("connect must be a function.", call. = FALSE)
    if (!plot_backend %in% c("jgd", "auto")) {
        return(connect(allow_jgd = TRUE))
    }
    jgd_setup <- vscode_r_load_prepare_helper(tool_prepare_helper, "jgd")
    if (!is.null(jgd_setup) && is.function(jgd_setup$vscode_r_connect_with_jgd)) {
        return(jgd_setup$vscode_r_connect_with_jgd(
            plot_backend, connect, tool_root, tool_consent_directory,
            tool_library_helper, tool_consent_helper, can_prompt, minimum_version
        ))
    }
    message("vscode-R could not load managed jgd setup resources; using the available plot fallback.")
    connect(allow_jgd = FALSE)
}

# Prepare rstudioapi before sess starts its emulation. Declining or failing only
# prints a message; sess emulation stays enabled and patches rstudioapi
# whenever it is loaded. Does nothing when emulation is disabled.
vscode_r_with_rstudioapi <- function(
    use_rstudioapi,
    tool_prepare_helper = Sys.getenv("VSCODE_R_TOOL_PREPARE_HELPER", unset = ""),
    tool_root = Sys.getenv("VSCODE_R_TOOL_ROOT", unset = ""),
    tool_consent_directory = Sys.getenv("VSCODE_R_TOOL_CONSENT_DIRECTORY", unset = ""),
    tool_library_helper = Sys.getenv("VSCODE_R_TOOL_LIBRARY_HELPER", unset = ""),
    tool_consent_helper = Sys.getenv("VSCODE_R_TOOL_CONSENT_HELPER", unset = ""),
    can_prompt = identical(Sys.getenv("VSCODE_R_RSTUDIOAPI_CAN_PROMPT", unset = "TRUE"), "TRUE"),
    minimum_version = Sys.getenv("VSCODE_R_RSTUDIOAPI_MINIMUM_VERSION", unset = "")
) {
    if (identical(use_rstudioapi, FALSE)) {
        return(invisible(FALSE))
    }
    setup <- vscode_r_load_prepare_helper(tool_prepare_helper, "rstudioapi")
    if (!is.null(setup) && is.function(setup$vscode_r_prepare_rstudioapi)) {
        return(invisible(isTRUE(setup$vscode_r_prepare_rstudioapi(
            use_rstudioapi, tool_root, tool_consent_directory,
            tool_library_helper, tool_consent_helper, can_prompt, minimum_version
        ))))
    }
    message("vscode-R could not load managed rstudioapi setup resources; continuing without it.")
    invisible(FALSE)
}

vscode_r_prepare_sess <- function(pkg_path, managed_root, consent_dir,
                                  source_helper, installer_helper,
                                  timeout_seconds = 180,
                                  setup_timeout_seconds = 300) {
    source(source_helper, local = TRUE)
    expected <- sess_source_revision(file.path(pkg_path, "DESCRIPTION"))
    if (is.null(expected)) {
        stop("Bundled sess has no valid source revision.")
    }
    runtime <- sess_runtime_identity()
    managed_library <- sess_managed_library(managed_root, expected)

    loaded <- "sess" %in% loadedNamespaces()
    if (loaded) {
        loaded_revision <- sess_loaded_source_revision()
        if (!identical(loaded_revision, expected)) {
            stop(paste(
                "A different sess namespace is already loaded.",
                "Close this R session and start a new one before attaching the session watcher.",
                "Reloading VS Code does not restart a persistent R session."
            ))
        }
        ns <- asNamespace("sess")
    } else {
        library <- sess_find_source_library(expected, .libPaths())
        if (!is.null(library)) {
            ns <- sess_load_namespace(library, expected)
        } else {
            lock_parent <- dirname(managed_library)
            dir.create(lock_parent, recursive = TRUE, showWarnings = FALSE)
            if (!dir.exists(lock_parent) || file.access(lock_parent, 2L) != 0L) {
                stop("The vscode-R managed sess setup directory is not writable.")
            }
            lock_path <- file.path(lock_parent, ".setup-lock")
            # Keep lock ownership rules in sync with src/interactive/backends/sessPreparation.ts:
            # mkdir claims atomically; only the owner releases via on.exit; timeout never clears a stale lock.
            # This revision lock covers consent, install, and load; a follower without a ready copy does not prompt.
            # Publish .ready with the source revision only after the exact namespace has loaded successfully.
            lock_deadline <- Sys.time() + setup_timeout_seconds
            lock_timeout_message <- paste(
                "Timed out waiting for another sess setup. Its owner may have crashed;",
                "retrying alone will not clear the stale lock. Remove",
                shQuote(lock_path), "only if its owner has exited, then retry."
            )
            followed_setup <- FALSE
            repeat {
                acquired <- dir.create(lock_path, showWarnings = FALSE, mode = "0700")
                if (isTRUE(acquired)) {
                    on.exit(unlink(lock_path, recursive = TRUE, force = TRUE), add = TRUE)
                    break
                }
                followed_setup <- TRUE
                if (!file.exists(lock_path)) {
                    if (file.access(lock_parent, 2L) != 0L) {
                        stop("The vscode-R managed sess setup directory is not writable.")
                    }
                    if (Sys.time() >= lock_deadline) {
                        stop(lock_timeout_message)
                    }
                    Sys.sleep(0.1)
                    next
                }
                if (!dir.exists(lock_path)) {
                    stop("A file is blocking the vscode-R managed sess setup lock.")
                }
                if (Sys.time() >= lock_deadline) {
                    stop(lock_timeout_message)
                }
                Sys.sleep(0.1)
            }

            ready_path <- file.path(lock_parent, ".ready")
            ready_revision <- tryCatch(
                readLines(ready_path, warn = FALSE, n = 2L),
                warning = function(e) character(),
                error = function(e) character()
            )
            installed <- sess_find_source_library(expected, managed_library)
            if (length(ready_revision) == 1L && identical(ready_revision, expected) &&
                    !is.null(installed)) {
                ns <- sess_load_namespace(installed, expected)
            } else if (followed_setup) {
                return(NULL)
            } else {
                existing <- any(vapply(.libPaths(), function(library) {
                    file.exists(file.path(library, "sess", "DESCRIPTION"))
                }, FALSE))
                reason <- if (existing) {
                    "mismatch"
                } else {
                    "missing"
                }
                if (!dir.exists(consent_dir)) {
                    stop("The extension's sess consent service is unavailable. Restart VS Code and try again.")
                }
                new_id_part <- function() {
                    temporary <- basename(tempfile(pattern = "request-", tmpdir = consent_dir))
                    gsub("[^A-Za-z0-9_-]", "", sub("^request-", "", temporary))
                }
                id <- paste0(new_id_part(), new_id_part())
                if (!grepl("^[A-Za-z0-9_-]{16,64}$", id)) {
                    stop("Could not create a unique sess installation request.")
                }
                request <- paste(
                                 "vscode-r-sess-consent-v1", id, expected, runtime, reason, sep = "\n")
                request_path <- file.path(consent_dir, paste0(id, ".request"))
                response_path <- file.path(consent_dir, paste0(id, ".response"))
                temporary_path <- tempfile(pattern = paste0(id, "-"), tmpdir = consent_dir)
                on.exit(unlink(c(temporary_path, request_path, response_path)), add = TRUE)
                writeLines(request, temporary_path, useBytes = TRUE)
                if (.Platform$OS.type == "unix") {
                    Sys.chmod(temporary_path, "0600")
                }
                if (!file.rename(temporary_path, request_path)) {
                    stop("Could not request permission to install bundled sess.")
                }

                deadline <- Sys.time() + timeout_seconds
                response <- ""
                while (Sys.time() < deadline && dir.exists(consent_dir) && !nzchar(response)) {
                    if (file.exists(response_path)) {
                        lines <- tryCatch(
                                          readLines(response_path, warn = FALSE, n = 2L),
                                          error = function(e) character())
                        if (length(lines) == 1L && lines %in% c("approve", "decline")) {
                            response <- lines
                        } else {
                            stop("Invalid response to the sess installation request.")
                        }
                    } else {
                        Sys.sleep(0.2)
                    }
                }
                if (!identical(response, "approve")) {
                    message("Bundled sess was not installed. The session watcher was not attached.")
                    return(NULL)
                }

                unlink(ready_path, force = TRUE)
                ready_link <- Sys.readlink(ready_path)
                if (file.exists(ready_path) || dir.exists(ready_path) ||
                        (length(ready_link) && !is.na(ready_link) && nzchar(ready_link))) {
                    stop("Could not clear the previous vscode-R managed sess completion marker.")
                }
                configured <- getOption("repos")
                repo <- if ("CRAN" %in% names(configured)) {
                    configured[["CRAN"]]
                } else if (length(configured)) {
                    configured[[1L]]
                } else {
                    "https://cloud.r-project.org"
                }
                if (!length(repo) || is.na(repo) || !nzchar(repo) || identical(repo, "@CRAN@")) {
                    repo <- "https://cloud.r-project.org"
                }
                dir.create(managed_library, recursive = TRUE, showWarnings = FALSE)
                if (file.access(managed_library, 2L) != 0L) {
                    stop("The vscode-R managed sess library is not writable.")
                }
                installer <- new.env(parent = baseenv())
                sys.source(installer_helper, envir = installer)
                installer$sess_install(pkg_path, managed_library, repo)
                ns <- sess_load_namespace(managed_library, expected)
                ready_temporary <- tempfile(pattern = ".ready-", tmpdir = lock_parent)
                on.exit(unlink(ready_temporary), add = TRUE)
                writeLines(expected, ready_temporary, useBytes = TRUE)
                if (.Platform$OS.type == "unix") {
                    Sys.chmod(ready_temporary, "0600")
                }
                if (!file.rename(ready_temporary, ready_path)) {
                    stop("Could not publish the vscode-R managed sess completion marker.")
                }
            }
        }
    }

    ns
}

vscode_r_attach_sess <- function(endpoint, pkg_path, managed_root, consent_dir,
                                 source_helper, installer_helper, plot_backend,
                                 timeout_seconds = 180,
                                 setup_timeout_seconds = 300,
                                 use_rstudioapi = TRUE,
                                 attachment_id = NULL,
                                 auto_activate = TRUE,
                                 tool_root = Sys.getenv("VSCODE_R_TOOL_ROOT", unset = ""),
                                 tool_consent_directory = Sys.getenv(
                                     "VSCODE_R_TOOL_CONSENT_DIRECTORY", unset = ""
                                 ),
                                 tool_library_helper = Sys.getenv(
                                     "VSCODE_R_TOOL_LIBRARY_HELPER", unset = ""
                                 ),
                                 tool_consent_helper = Sys.getenv(
                                     "VSCODE_R_TOOL_CONSENT_HELPER", unset = ""
                                 ),
                                 tool_prepare_helper = Sys.getenv(
                                     "VSCODE_R_TOOL_PREPARE_HELPER", unset = ""
                                 ),
                                 jgd_can_prompt = TRUE,
                                 jgd_minimum_version = Sys.getenv(
                                     "VSCODE_R_JGD_MINIMUM_VERSION", unset = ""
                                 ),
                                 rstudioapi_can_prompt = TRUE,
                                 rstudioapi_minimum_version = Sys.getenv(
                                     "VSCODE_R_RSTUDIOAPI_MINIMUM_VERSION", unset = ""
                                 )) {
    if (!is.null(attachment_id) &&
            !(is.character(attachment_id) && length(attachment_id) == 1L &&
                  !is.na(attachment_id) &&
                  grepl("^[A-Za-z0-9_-]{1,128}$", attachment_id, useBytes = TRUE))) {
        stop("attachment_id must be NULL or a 1-128 character ASCII identifier.", call. = FALSE)
    }
    if (!(is.logical(auto_activate) && length(auto_activate) == 1L && !is.na(auto_activate))) {
        stop("auto_activate must be a single non-NA logical value.", call. = FALSE)
    }
    if (!auto_activate && is.null(attachment_id)) {
        stop("auto_activate = FALSE requires attachment_id.", call. = FALSE)
    }

    registered <- getOption("vscodeR.terminalStartup")
    profile_process <- is.list(registered) && identical(registered$pid, Sys.getpid())
    startup_context <- NULL
    if (profile_process) {
        notifier_available <- exists("vscode_r_startup_existing", mode = "function") &&
            exists("vscode_r_startup_run", mode = "function")
        if (!notifier_available) {
            startup_helper <- Sys.getenv("VSCODE_R_SESS_STARTUP_HELPER", unset = "")
            if (nzchar(startup_helper) && file.exists(startup_helper)) {
                tryCatch(source(startup_helper, local = TRUE), error = function(error) {
                    message("vscode-R could not load terminal startup notifier: ", conditionMessage(error))
                })
            }
            notifier_available <- exists("vscode_r_startup_existing", mode = "function") &&
                exists("vscode_r_startup_run", mode = "function")
        }
        if (!notifier_available) {
            message("vscode-R terminal startup notifier is unavailable; the session watcher was not attached.")
            return(invisible(FALSE))
        }
        startup_context <- vscode_r_startup_existing(endpoint)
        if (is.null(startup_context)) {
            message("vscode-R could not validate terminal startup status; the session watcher was not attached.")
            return(invisible(FALSE))
        }
    }

    attach <- function() {
        ns <- vscode_r_prepare_sess(pkg_path, managed_root, consent_dir, source_helper, installer_helper,
                                    timeout_seconds, setup_timeout_seconds)
        if (is.null(ns)) {
            return(invisible(FALSE))
        }
        connect <- get("connect", envir = ns, inherits = FALSE)
        args <- list(endpoint = endpoint, plot_backend = plot_backend,
                     use_rstudioapi = use_rstudioapi)
        # Preserve compatibility with older sess namespaces and helper stubs
        # when the caller uses the legacy, untagged attach path.
        if (!is.null(attachment_id)) {
            args$attachment_id <- attachment_id
            args$auto_activate <- auto_activate
        }
        vscode_r_with_rstudioapi(
            use_rstudioapi, tool_prepare_helper, tool_root, tool_consent_directory,
            tool_library_helper, tool_consent_helper, rstudioapi_can_prompt,
            rstudioapi_minimum_version
        )
        vscode_r_with_jgd(
            plot_backend,
            function(allow_jgd = TRUE) {
                args$allow_jgd <- allow_jgd
                do.call(connect, args)
            },
            tool_prepare_helper, tool_root, tool_consent_directory,
            tool_library_helper, tool_consent_helper, jgd_can_prompt, jgd_minimum_version
        )
    }

    if (profile_process) {
        return(vscode_r_startup_run(startup_context, attach))
    }
    attach()
}
