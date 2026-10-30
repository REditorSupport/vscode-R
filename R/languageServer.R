.paths <- .libPaths()

add_lib_paths <- Sys.getenv("VSCR_LIB_PATHS")
if (nzchar(add_lib_paths)) {
    add_lib_paths <- strsplit(add_lib_paths, "\n", fixed = TRUE)[[1L]]
    .paths <- c(.paths, add_lib_paths)
    .libPaths(.paths)
}

use_renv_lib_path <- Sys.getenv("VSCR_USE_RENV_LIB_PATH")
use_renv_lib_path <- if (nzchar(use_renv_lib_path)) as.logical(use_renv_lib_path) else FALSE
if (use_renv_lib_path) {
    if (requireNamespace("renv", quietly = TRUE)) {
        .paths <- c(.paths, renv::paths$cache())
    } else {
        warning("renv package is not installed. Please install renv to use renv library path.")
    }
}

.libPaths(.paths)
message("R library paths: ", paste(.libPaths(), collapse = "\n"))

if (!requireNamespace("languageserver", quietly = TRUE)) {
    q(save = "no", status = 10)
}

debug <- Sys.getenv("VSCR_LSP_DEBUG")
port <- Sys.getenv("VSCR_LSP_PORT")

debug <- if (nzchar(debug)) as.logical(debug) else FALSE
port <- if (nzchar(port)) as.integer(port) else NULL

if (identical(Sys.getenv("VSCR_LSP_VIRTUAL_DOCUMENTS"), "TRUE")) {
    # lintr's disk cache reads the source filename, but virtual cells have no
    # corresponding R file. Keep diagnostics enabled and lint their live text.
    options(languageserver.lint_cache = FALSE)
}

if (identical(Sys.getenv("VSCR_LSP_SYNTHETIC_WORKSPACE"), "TRUE")) {
    # A session directory supplies context for virtual documents, but is not an
    # opened project. Avoid recursively indexing it (it may be the home folder).
    options(languageserver.index_mode = "off")
}

tools::Rd2txt_options(underline_titles = FALSE)
tools::Rd2txt_options(itemBullet = "* ")
languageserver:::lsp_settings$update_from_options()
if (isTRUE(debug)) {
    languageserver:::lsp_settings$set("debug", TRUE)
    languageserver:::lsp_settings$set("log_file", NULL)
}

normalize_character <- function(value) {
    if (is.list(value)) {
        value <- unlist(value, use.names = FALSE)
    }
    if (!is.character(value)) {
        return(character())
    }
    unique(value[nzchar(value)])
}

# This is intentionally an optional integration. Older languageserver
# installations still provide ordinary static LSP features; don't mutate
# unsupported private structures or leave attached packages behind on reset.
namespace <- asNamespace("languageserver")
startup_fn <- get0("workspace_startup_packages", namespace, inherits = FALSE)
server <- languageserver:::LanguageServer$new("localhost", port)
default_library_paths <- .libPaths()
default_startup <- if (is.function(startup_fn)) startup_fn() else character()
# Keep the project NAMESPACE imports separate from the temporary packages
# attached in the interactive R process; S3 resolution consults imports as
# well as the workspace startup list.
session_state <- new.env(parent = emptyenv())
namespace_imports <- get0("extract_namespace_imports", namespace, inherits = FALSE)

# Read static NAMESPACE imports independently from session-attached packages.
# The imported package set is otherwise indistinguishable when they overlap.
workspace_static_imports <- function(root) {
    if (length(root) != 1L) return(character())
    file <- file.path(root, "NAMESPACE")
    if (!file.exists(file)) return(character())
    if (is.function(namespace_imports)) return(namespace_imports(file)$packages)

    # Released languageserver versions with startup_packages, but without the
    # newer namespace parser, handle ordinary import() directives here.
    expressions <- tryCatch(parse(file, keep.source = FALSE), error = function(e) expression())
    packages <- unlist(lapply(expressions, function(expr) {
        if (!is.call(expr) || !identical(expr[[1L]], quote(import))) return(character())
        args <- as.list(expr)[-1L]
        values <- vapply(args, function(arg) {
            if (is.name(arg) || is.character(arg)) as.character(arg)[1L] else ""
        }, character(1L), USE.NAMES = FALSE)
        values[nzchar(values)]
    }), use.names = FALSE)
    unique(packages)
}
session_state$revision <- 0L
session_state$pending_reply <- NULL

server$request_handlers[["r/syncSessionState"]] <- function(self, id, params) {
    # A superseded worker discards its callback. Acknowledge its request so
    # TypeScript can deliver the next state, including a disconnect clear.
    session_state$revision <- session_state$revision + 1L
    revision <- session_state$revision
    if (is.function(session_state$pending_reply)) session_state$pending_reply(FALSE)
    session_state$pending_reply <- NULL
    if (!is.null(self$resolve_task_manager) &&
            is.function(self$resolve_task_manager$cancel)) {
        self$resolve_task_manager$cancel("r/syncSessionState")
    }

    response_state <- new.env(parent = emptyenv())
    response_state$replied <- FALSE
    reply <- function(applied) {
        if (response_state$replied) return(invisible(NULL))
        response_state$replied <- TRUE
        if (identical(session_state$pending_reply, reply)) {
            session_state$pending_reply <- NULL
        }
        self$deliver(languageserver:::Response$new(id, result = applied))
        invisible(NULL)
    }
    if (!is.function(startup_fn)) {
        # Older languageserver versions cannot support this feature.
        reply("unsupported")
        return(invisible(NULL))
    }
    if (is.null(tryCatch(self$workspaces, error = function(e) NULL))) {
        reply(FALSE)
        return(invisible(NULL))
    }

    tryCatch({
        attached_packages <- normalize_character(params$attachedPackages)
        loaded_namespaces <- normalize_character(params$loadedNamespaces)
        library_paths <- normalize_character(params$libraryPaths)
        locations <- params$packagePaths
        if (!is.list(locations)) locations <- list()
        package_paths <- unlist(locations, use.names = TRUE)
        if (!is.character(package_paths)) package_paths <- character()
        package_paths <- package_paths[nzchar(package_paths)]
        extra_paths <- dirname(package_paths)
        candidate_paths <- if (length(attached_packages)) {
            unique(c(extra_paths, library_paths, default_library_paths))
        } else {
            default_library_paths
        }
        candidate_paths <- candidate_paths[dir.exists(candidate_paths)]
        .libPaths(candidate_paths)

        # A server can outlive an R session. Removing the previous package
        # metadata avoids stale members and S3 signatures after detach.
        for (workspace in self$workspaces$values()) {
            base_imports <- workspace_static_imports(workspace$root)
            previous <- workspace$startup_packages
            new_startup <- if (length(attached_packages)) rev(attached_packages) else default_startup
            removed <- setdiff(previous, unique(c(new_startup, base_imports)))
            workspace$startup_packages <- new_startup
            workspace$imported_packages <- union(base_imports, attached_packages)
            workspace$update_loaded_packages()
            for (pkg in unique(c(attached_packages, loaded_namespaces))) {
                try(workspace$get_namespace(pkg), silent = TRUE)
            }
            if (length(removed) && !is.null(workspace$namespaces)) {
                for (pkg in removed) {
                    if (workspace$namespaces$has(pkg)) {
                        workspace$namespaces$remove(pkg)
                    }
                }
            }
            if (length(removed) && !is.null(workspace$member_metadata)) {
                for (pkg in removed) {
                    if (is.function(workspace$member_metadata$remove)) {
                        workspace$member_metadata$remove(pkg)
                    }
                }
            }
            if (length(removed) && !is.null(workspace$s3_metadata) &&
                    is.function(workspace$s3_metadata$clear)) {
                keep <- setdiff(workspace$s3_metadata$keys(), removed)
                snapshots <- lapply(keep, workspace$s3_metadata$get)
                names(snapshots) <- keep
                workspace$s3_metadata$clear()
                for (pkg in names(snapshots)) {
                    workspace$s3_metadata$set(pkg, snapshots[[pkg]])
                }
            }
        }

        missing <- attached_packages[
            !vapply(
                attached_packages,
                function(pkg) length(find.package(pkg, quiet = TRUE)) > 0L,
                logical(1L)
            )
        ]
        if (length(missing)) {
            message(
                "Session packages cannot be resolved by languageserver: ",
                paste(missing, collapse = ", ")
            )
            reply(FALSE)
            return(invisible(NULL))
        }

        # Prepare the independent member and S3 metadata providers in a worker.
        # Only prepare on state updates, never in ordinary completion requests.
        # Keep the request pending until metadata is available to the providers.
        prepare <- get0("member_resolve_packages", namespace, inherits = FALSE)
        if (!length(attached_packages) || !is.function(prepare) ||
                is.null(self$resolve_task_manager)) {
            reply(TRUE)
            return(invisible(NULL))
        }
        create_task <- get0("create_task", namespace, inherits = FALSE)
        package_call <- get0("package_call", namespace, inherits = FALSE)
        if (!is.function(create_task) || !is.function(package_call)) {
            reply(FALSE)
            return(invisible(NULL))
        }
        task <- create_task(
            target = package_call(prepare),
            args = list(
                pkgs = attached_packages,
                lib_paths = .libPaths(),
                namespace_packages = character(),
                prepare = isTRUE(languageserver:::lsp_settings$get("member_completion")),
                prepare_s3 = isTRUE(languageserver:::lsp_settings$get("s3_dispatch"))
            ),
            callback = function(result) {
                if (!identical(revision, session_state$revision)) return(invisible(NULL))
                tryCatch({
                    for (workspace in self$workspaces$values()) {
                        if (!is.null(result$members) && !is.null(workspace$member_metadata)) {
                            for (pkg in names(result$members)) {
                                workspace$member_metadata$set(pkg, result$members[[pkg]])
                            }
                        }
                        if (!is.null(result$s3) && !is.null(workspace$s3_metadata)) {
                            for (pkg in names(result$s3)) {
                                workspace$s3_metadata$set(pkg, result$s3[[pkg]])
                            }
                        }
                    }
                    reply(TRUE)
                }, error = function(e) {
                    message("Session package metadata could not be applied: ", conditionMessage(e))
                    reply(FALSE)
                })
            },
            error = function(e) {
                if (identical(revision, session_state$revision)) {
                    message("Session package metadata could not be prepared: ", conditionMessage(e))
                    reply(FALSE)
                }
            },
            profiles = FALSE
        )
        session_state$pending_reply <- reply
        self$resolve_task_manager$add_task("r/syncSessionState", task)
    }, error = function(e) {
        message("Session package synchronization failed: ", conditionMessage(e))
        reply(FALSE)
    })
    invisible(NULL)
}

server$run()
