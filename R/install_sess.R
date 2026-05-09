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
})
