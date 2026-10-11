local({
    args <- commandArgs(trailingOnly = TRUE)
    pkg_path <- if (length(args) >= 1L && nzchar(args[1L])) args[1L] else
        Sys.getenv("VSCODE_R_SESS_PKG_PATH", unset = "")

    if (!nzchar(pkg_path)) {
        stop("Missing pkg_path (set VSCODE_R_SESS_PKG_PATH or pass as first command arg)")
    }

    repo <- if (length(args) >= 2L && nzchar(args[2L])) args[2L] else
        Sys.getenv("VSCODE_R_SESS_REPO", unset = "")
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
    library_arg <- if (length(args) >= 3L) args[3L] else ""
    if (!length(repo) || is.na(repo) || !nzchar(repo) || identical(repo, "@CRAN@")) {
        repo <- "https://cloud.r-project.org"
    }

    if (!file.exists(file.path(pkg_path, "DESCRIPTION"))) {
        stop(paste("DESCRIPTION file not found in", pkg_path))
    }

    # Resolve the helper beside this script, independently of the package's
    # staging path. source() records ofile; an R task supplies --file instead.
    script_files <- unlist(lapply(sys.frames(), function(frame) frame$ofile))
    if (!length(script_files)) {
        script_files <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE))
        # The Unix R launcher encodes spaces in --file values before invoking R.
        if (.Platform$OS.type == "unix") {
            script_files <- gsub("~+~", " ", script_files, fixed = TRUE)
        }
    }
    if (!length(script_files)) {
        stop("Cannot locate install_sess.R")
    }
    script_directory <- dirname(tail(script_files, 1))
    source(file.path(script_directory, "sess_source.R"), local = TRUE)
    expected_revision <- sess_source_revision(file.path(pkg_path, "DESCRIPTION"))
    if (is.null(expected_revision)) {
        stop("Bundled sess has no valid source revision. Rebuild or reinstall the vscode-R extension.")
    }

    library <- if (nzchar(library_arg)) library_arg else
        Sys.getenv("VSCODE_R_SESS_LIBRARY", unset = "")
    if (!nzchar(library)) {
        stop("Missing VSCODE_R_SESS_LIBRARY. Refusing to install sess into a default R library.")
    }
    dir.create(library, recursive = TRUE, showWarnings = FALSE)
    if (file.access(library, 2L) != 0L) stop(paste("R library is not writable:", library))
    installer <- new.env(parent = baseenv())
    sys.source(file.path(script_directory, "sess-package-install.R"), envir = installer)
    installer$sess_install(pkg_path, library, repo,
                           interactive = identical(Sys.getenv("VSCODE_R_SESS_INTERACTIVE"), "1"))
    if ("sess" %in% loadedNamespaces()) {
        message("sess was already loaded. Restart R to use the newly installed source.")
    }
})
