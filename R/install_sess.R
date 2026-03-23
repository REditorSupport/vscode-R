local({
    args <- commandArgs(trailingOnly = TRUE)
    if (length(args) < 2) {
        stop("Missing arguments: pkg_path and repo")
    }
    pkg_path <- args[1]
    repo <- args[2]

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
        install.packages(deps, repos = repo)
    }

    message("Installing sess package from: ", pkg_path)
    install.packages(pkg_path, repos = NULL, type = "source")
})
