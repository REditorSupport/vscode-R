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

sess_runtime_identity <- function() {
    minor <- strsplit(R.version$minor, ".", fixed = TRUE)[[1L]][1L]
    version <- paste(R.version$major, minor, sep = ".")
    if (!grepl("^[A-Za-z0-9_.-]+$", R.version$platform) || !grepl("^[0-9]+\\.[0-9]+$", version)) {
        stop("Unsupported R platform or version for managed sess library.")
    }
    paste(R.version$platform, version, sep = "|")
}

sess_managed_library <- function(root, revision) {
    identity <- strsplit(sess_runtime_identity(), "|", fixed = TRUE)[[1L]]
    if (length(identity) != 2L || !grepl("^git-tree:([a-f0-9]{40}|[a-f0-9]{64})$", revision)) {
        stop("Cannot determine the managed sess library identity.")
    }
    file.path(root, identity[[1L]], identity[[2L]], sub("^git-tree:", "", revision), "library")
}

sess_installed_source_revision <- function(lib.loc = .libPaths()) {
    # Explicit lib.loc reads the copy selected by .libPaths(), even if a different
    # copy is already loaded. Do not load sess just to inspect its DESCRIPTION.
    for (library in lib.loc) {
        pkg <- file.path(library, "sess")
        if (file.exists(file.path(pkg, "DESCRIPTION"))) {
            revision <- sess_source_revision(file.path(pkg, "DESCRIPTION"))
            if (!is.null(revision)) {
                return(revision)
            }
        }
    }
    NULL
}

sess_has_source_revision <- function(revision, lib.loc = .libPaths()) {
    !is.null(sess_find_source_library(revision, lib.loc))
}

sess_find_source_library <- function(revision, lib.loc = .libPaths()) {
    for (library in lib.loc) {
        pkg <- file.path(library, "sess")
        if (file.exists(file.path(pkg, "DESCRIPTION")) &&
                identical(sess_source_revision(file.path(pkg, "DESCRIPTION")), revision)) {
            return(library)
        }
    }
    NULL
}

sess_loaded_source_revision <- function() {
    if (!("sess" %in% loadedNamespaces())) {
        return(NULL)
    }
    path <- getNamespaceInfo(asNamespace("sess"), "path")
    sess_source_revision(file.path(path, "DESCRIPTION"))
}

sess_load_namespace <- function(library, revision, normal_libraries = .libPaths()) {
    paths <- unique(c(library, normal_libraries))
    support_paths <- unique(c(normal_libraries, library))
    description <- read.dcf(file.path(library, "sess", "DESCRIPTION"))
    imports <- if ("Imports" %in% colnames(description)) {
        trimws(gsub("\\s*\\(.*\\)", "", unlist(strsplit(description[1L, "Imports"], ","))))
    } else {
        character()
    }
    # processx may load ps during .onLoad. Load it first so dependencies found
    # only in the managed library remain visible without changing .libPaths().
    if ("processx" %in% imports) {
        loadNamespace("ps", lib.loc = support_paths)
    }
    for (package in intersect(c("jsonlite", "later", "processx", "rstudioapi"), imports)) {
        loadNamespace(package, lib.loc = support_paths)
    }
    ns <- loadNamespace("sess", lib.loc = paths)
    actual_path <- normalizePath(getNamespaceInfo(ns, "path"), winslash = "/", mustWork = TRUE)
    intended_path <- normalizePath(file.path(library, "sess"), winslash = "/", mustWork = TRUE)
    actual_revision <- sess_source_revision(file.path(actual_path, "DESCRIPTION"))
    if (!identical(actual_path, intended_path) || !identical(actual_revision, revision)) {
        stop("Loaded sess does not match the selected vscode-R source. Restart R before attaching the session watcher.")
    }
    ns
}

sess_install_required <- function(pkg_path) {
    bundled <- sess_source_revision(file.path(pkg_path, "DESCRIPTION"))
    if (is.null(bundled)) {
        stop("Bundled sess has no valid source revision. Rebuild or reinstall the vscode-R extension.")
    }
    !sess_has_source_revision(bundled)
}
