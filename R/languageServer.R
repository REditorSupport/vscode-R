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

server <- languageserver:::LanguageServer$new("localhost", port)
server$request_handlers[["r/syncSessionState"]] <- function(self, id, params) {
    attached_packages <- normalize_character(params$attachedPackages)
    loaded_namespaces <- normalize_character(params$loadedNamespaces)

    for (workspace in self$workspaces$values()) {
        workspace$startup_packages <- if (length(attached_packages)) {
            # languageserver resolves package conflicts from the end of this list.
            rev(attached_packages)
        } else {
            languageserver:::workspace_startup_packages()
        }
        workspace$update_loaded_packages()

        for (pkg in unique(c(attached_packages, loaded_namespaces))) {
            try(workspace$get_namespace(pkg), silent = TRUE)
        }
    }

    self$deliver(languageserver:::Response$new(id, result = TRUE))
}

server$run()
