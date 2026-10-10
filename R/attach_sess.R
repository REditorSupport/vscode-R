# Manual attach setup. Installation requires a single-use grant from the
# extension process; this helper never changes .libPaths().
vscode_r_attach_sess <- function(endpoint, pkg_path, managed_root, consent_dir,
                                 source_helper, installer_helper, plot_backend,
                                 timeout_seconds = 180) {
    source(source_helper, local = TRUE)
    expected <- sess_source_revision(file.path(pkg_path, "DESCRIPTION"))
    if (is.null(expected)) stop("Bundled sess has no valid source revision.")
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
            installed <- sess_find_source_library(expected, managed_library)
            if (!is.null(installed)) {
                ns <- sess_load_namespace(installed, expected)
            } else {
                existing <- any(vapply(.libPaths(), function(library) {
                    file.exists(file.path(library, "sess", "DESCRIPTION"))
                }, FALSE))
                reason <- if (existing) "mismatch" else "missing"
                if (!dir.exists(consent_dir)) {
                    stop("The extension's sess consent service is unavailable. Restart VS Code and try again.")
                }
                id_parts <- vapply(seq_len(2L), function(unused) {
                    gsub("[^A-Za-z0-9_-]", "",
                         sub("^request-", "", basename(tempfile(pattern = "request-", tmpdir = consent_dir))))
                }, "")
                id <- paste0(id_parts, collapse = "")
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
                if (.Platform$OS.type == "unix") Sys.chmod(temporary_path, "0600")
                if (!file.rename(temporary_path, request_path)) {
                    stop("Could not request permission to install bundled sess.")
                }

                deadline <- Sys.time() + timeout_seconds
                response <- ""
                while (Sys.time() < deadline && dir.exists(consent_dir) && !nzchar(response)) {
                    if (file.exists(response_path)) {
                        lines <- tryCatch(readLines(response_path, warn = FALSE, n = 2L), error = function(e) character())
                        if (length(lines) == 1L && lines %in% c("approve", "decline")) response <- lines
                        else stop("Invalid response to the sess installation request.")
                    } else Sys.sleep(0.2)
                }
                if (!identical(response, "approve")) {
                    message("Bundled sess was not installed. The session watcher was not attached.")
                    return(invisible(FALSE))
                }

                configured <- getOption("repos")
                repo <- if ("CRAN" %in% names(configured)) configured[["CRAN"]] else
                    if (length(configured)) configured[[1L]] else "https://cloud.r-project.org"
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
            }
        }
    }

    get("connect", envir = ns, inherits = FALSE)(endpoint = endpoint, plot_backend = plot_backend)
    invisible(TRUE)
}
