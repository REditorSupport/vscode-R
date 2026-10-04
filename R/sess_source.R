# Deployment identity only. Runtime compatibility is checked by protocol_version.
sess_source_revision <- function(description_path) {
    tryCatch({
        desc <- read.dcf(description_path, fields = "Config/vscode-R/source-revision")
        revision <- unname(desc[1, 1])
        if (is.na(revision) || !grepl("^git-tree:([a-f0-9]{40}|[a-f0-9]{64})$", revision)) {
            return(NULL)
        }
        revision
    }, error = function(e) NULL)
}

sess_installed_source_revision <- function() {
    # Explicit lib.loc reads the copy selected by .libPaths(), even if a different
    # copy is already loaded. Do not load sess just to inspect its DESCRIPTION.
    pkg <- find.package("sess", lib.loc = .libPaths(), quiet = TRUE)
    if (!length(pkg)) {
        return(NULL)
    }
    sess_source_revision(file.path(pkg, "DESCRIPTION"))
}

sess_install_required <- function(pkg_path) {
    bundled <- sess_source_revision(file.path(pkg_path, "DESCRIPTION"))
    if (is.null(bundled)) {
        stop("Bundled sess has no valid source revision. Rebuild or reinstall the vscode-R extension.")
    }
    !identical(sess_installed_source_revision(), bundled)
}
