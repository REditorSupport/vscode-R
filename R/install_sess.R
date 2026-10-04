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
        repo <- getOption("repos")[["CRAN"]]
    }
    if (is.na(repo) || identical(repo, "@CRAN@")) {
        repo <- ""
    }

    if (!file.exists(file.path(pkg_path, "DESCRIPTION"))) {
        stop(paste("DESCRIPTION file not found in", pkg_path))
    }

    # Resolve the helper beside this script, independently of the package's
    # staging path. source() records ofile; an R task supplies --file instead.
    script_files <- unlist(lapply(sys.frames(), function(frame) frame$ofile))
    if (!length(script_files)) {
        script_files <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE))
    }
    if (!length(script_files)) {
        stop("Cannot locate install_sess.R")
    }
    source(file.path(dirname(tail(script_files, 1)), "sess_source.R"), local = TRUE)
    expected_revision <- sess_source_revision(file.path(pkg_path, "DESCRIPTION"))
    if (is.null(expected_revision)) {
        stop("Bundled sess has no valid source revision. Rebuild or reinstall the vscode-R extension.")
    }

    desc <- read.dcf(file.path(pkg_path, "DESCRIPTION"))
    deps <- if ("Imports" %in% colnames(desc)) desc[, "Imports"] else ""
    deps <- unlist(strsplit(deps, ","))
    deps <- gsub("\\s*\\(.*\\)", "", deps)
    deps <- trimws(deps)
    # Filter out base packages and already installed packages
    deps <- deps[nzchar(deps)]
    installed <- rownames(installed.packages())
    base_pkgs <- rownames(installed.packages(priority = "base"))
    deps <- deps[!deps %in% base_pkgs & !deps %in% installed]

    if (length(deps) > 0) {
        message("Installing dependencies: ", paste(deps, collapse = ", "))
        if (nzchar(repo)) {
            install.packages(deps, repos = repo)
        } else {
            install.packages(deps)
        }
    }

    message("Installing sess package from: ", pkg_path)
    install.packages(pkg_path, repos = NULL, type = "source")
    # install.packages can report failure as a warning. Also detect a different
    # package shadowing the installed copy earlier in .libPaths().
    if (!identical(sess_installed_source_revision(), expected_revision)) {
        stop("sess installation did not make the bundled source available in .libPaths(). Check the installation log.")
    }
    if ("sess" %in% loadedNamespaces()) {
        message("sess was already loaded. Restart R to use the newly installed source.")
    }
})
