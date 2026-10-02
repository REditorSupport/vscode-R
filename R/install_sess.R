local({
    args <- commandArgs(trailingOnly = TRUE)
    pkg_path <- Sys.getenv("VSCODE_R_SESS_PKG_PATH", unset = "")
    if (!nzchar(pkg_path) && length(args) >= 1) {
        pkg_path <- args[1]
    }

    if (!nzchar(pkg_path)) {
        stop("Missing pkg_path (set VSCODE_R_SESS_PKG_PATH or pass as first command arg)")
    }

    repo <- Sys.getenv("VSCODE_R_SESS_REPO", unset = "")
    if (!nzchar(repo) && length(args) >= 2) {
        repo <- args[2]
    }
    if (!nzchar(repo)) {
        configured <- getOption("repos")
        repo <- if ("CRAN" %in% names(configured)) {
            configured[["CRAN"]]
        } else if (length(configured)) {
            configured[[1L]]
        } else {
            ""
        }
    }
    if (!length(repo) || is.na(repo) || !nzchar(repo) || identical(repo, "@CRAN@")) {
        repo <- "https://cloud.r-project.org"
    }

    if (!file.exists(file.path(pkg_path, "DESCRIPTION"))) {
        stop(paste("DESCRIPTION file not found in", pkg_path))
    }

    library <- Sys.getenv("VSCODE_R_SESS_LIBRARY", unset = "")
    private_library <- nzchar(library)
    if (!private_library) {
        library <- .libPaths()[1L]
        if (file.access(library, 2L) != 0L) {
            user_library <- strsplit(Sys.getenv("R_LIBS_USER"), .Platform$path.sep, fixed = TRUE)[[1L]]
            if (!length(user_library) || !nzchar(user_library[[1L]])) stop("No writable R library is available.")
            library <- path.expand(user_library[[1L]])
        }
    }
    dir.create(library, recursive = TRUE, showWarnings = FALSE)
    if (file.access(library, 2L) != 0L) stop(paste("R library is not writable:", library))
    if (!private_library) .libPaths(c(library, .libPaths()))
    installer <- new.env(parent = baseenv())
    sys.source(file.path(pkg_path, "..", "R", "sess-package-install.R"), envir = installer)
    installer$sess_install(pkg_path, library, repo,
                           interactive = identical(Sys.getenv("VSCODE_R_SESS_INTERACTIVE"), "1"))
})
