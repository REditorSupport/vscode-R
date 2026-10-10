# Shared terminal and manual-attach preparation. Installation requires a
# single-use grant from the extension process; .libPaths() is never changed.
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
            stop("A different sess namespace is already loaded. Restart R before attaching the session watcher.")
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
                                 setup_timeout_seconds = 300) {
    ns <- vscode_r_prepare_sess(
                                pkg_path, managed_root, consent_dir, source_helper, installer_helper,
                                timeout_seconds, setup_timeout_seconds)
    if (is.null(ns)) {
        return(invisible(FALSE))
    }
    get("connect", envir = ns, inherits = FALSE)(endpoint = endpoint, plot_backend = plot_backend)
    invisible(TRUE)
}
