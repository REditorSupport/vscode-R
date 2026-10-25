# R-side support for packages managed by vscode-R as optional tools.
# The allowlist is intentionally fixed here; callers may select a minimum version
# but cannot use this installer to fetch arbitrary package names or URLs.
.vscode_r_tool_packages <- c(jgd = "jgd")

tool_library_path <- function(root) {
    .tool_validate_root(root)
    minor <- strsplit(R.version$minor, ".", fixed = TRUE)[[1L]][1L]
    version <- paste(R.version$major, minor, sep = ".")
    if (!grepl("^[A-Za-z0-9_.-]+$", R.version$platform) ||
            !grepl("^[0-9]+\\.[0-9]+$", version)) {
        stop("Unsupported R platform or version for the managed tool library.")
    }
    file.path(root, "packages", R.version$platform, version, "library")
}

.tool_validate_root <- function(root) {
    if (!(is.character(root) && length(root) == 1L && !is.na(root) && nzchar(root))) {
        stop("A non-empty tool library root path is required.", call. = FALSE)
    }
    invisible(TRUE)
}

.tool_validate_request <- function(package, minimum_version) {
    if (!(is.character(package) && length(package) == 1L && !is.na(package) &&
              package %in% .vscode_r_tool_packages)) {
        stop("Package is not allowed in the vscode-R tool library.", call. = FALSE)
    }
    if (!(is.character(minimum_version) && length(minimum_version) == 1L &&
              !is.na(minimum_version) &&
              !inherits(tryCatch(package_version(minimum_version),
                                 error = identity), "error"))) {
        stop("A valid minimum package version is required.", call. = FALSE)
    }
    invisible(TRUE)
}

.tool_description <- function(path) {
    if (!file.exists(file.path(path, "DESCRIPTION"))) return(NULL)
    tryCatch(read.dcf(file.path(path, "DESCRIPTION")), error = function(e) NULL)
}

.tool_version_at <- function(package, library) {
    description <- .tool_description(file.path(library, package))
    if (is.null(description) || !"Version" %in% colnames(description)) return(NULL)
    unname(description[1L, "Version"])
}

.tool_version_ok <- function(version, minimum_version) {
    if (is.null(version) || length(version) != 1L || is.na(version)) return(FALSE)
    isTRUE(tryCatch(package_version(version) >= package_version(minimum_version),
                    error = function(e) FALSE))
}

.tool_namespace_path <- function(package) {
    if (!package %in% loadedNamespaces()) return(NULL)
    getNamespaceInfo(asNamespace(package), "path")
}

# Report what would satisfy a request without installing or loading anything.
# Returns package, version, source, install_required, and library fields. `source`
# is loaded, user, managed, install, or loaded-incompatible.
tool_library_check <- function(package, minimum_version, root) {
    .tool_validate_request(package, minimum_version)
    .tool_validate_root(root)
    loaded_path <- .tool_namespace_path(package)
    if (!is.null(loaded_path)) {
        version <- as.character(getNamespaceVersion(asNamespace(package)))
        compatible <- .tool_version_ok(version, minimum_version)
        return(list(package = package, version = version,
                    source = if (compatible) "loaded" else "loaded-incompatible",
                    install_required = FALSE, library = dirname(loaded_path)))
    }
    for (library in .libPaths()) {
        version <- .tool_version_at(package, library)
        if (.tool_version_ok(version, minimum_version)) {
            return(list(package = package, version = version, source = "user",
                        install_required = FALSE, library = library))
        }
    }
    library <- tool_library_path(root)
    version <- .tool_version_at(package, library)
    if (.tool_version_ok(version, minimum_version)) {
        return(list(package = package, version = version, source = "managed",
                    install_required = FALSE, library = library))
    }
    list(package = package, version = version, source = "install",
         install_required = TRUE, library = library)
}

.tool_dependencies_allowed <- function(description) {
    installed <- utils::installed.packages(fields = "Priority")
    allowed <- rownames(installed)[!is.na(installed[, "Priority"]) &
                                       installed[, "Priority"] %in% c("base", "recommended")]
    for (field in c("Depends", "Imports", "LinkingTo")) {
        if (!field %in% colnames(description) || is.na(description[1L, field])) next
        entries <- trimws(strsplit(description[1L, field], ",", fixed = TRUE)[[1L]])
        names <- sub("\\s*\\(.*$", "", entries)
        names <- setdiff(names[nzchar(names)], "R")
        if (length(setdiff(names, allowed))) return(FALSE)
    }
    TRUE
}

.tool_with_library_lock <- function(library, code, timeout_seconds = 300) {
    if (!(is.numeric(timeout_seconds) && length(timeout_seconds) == 1L &&
              !is.na(timeout_seconds) && is.finite(timeout_seconds) && timeout_seconds >= 0)) {
        stop("timeout_seconds must be a finite non-negative number.")
    }
    parent <- dirname(library)
    dir.create(parent, recursive = TRUE, showWarnings = FALSE)
    if (!dir.exists(parent) || file.access(parent, 2L) != 0L) {
        stop("The vscode-R managed tool library is not writable.")
    }
    lock <- file.path(parent, ".setup-lock")
    deadline <- Sys.time() + timeout_seconds
    repeat {
        if (isTRUE(dir.create(lock, showWarnings = FALSE, mode = "0700"))) {
            on.exit(unlink(lock, recursive = TRUE, force = TRUE), add = TRUE)
            return(force(code))
        }
        if (!dir.exists(lock)) {
            if (Sys.time() >= deadline) stop("Timed out waiting for the managed tool library lock.")
            Sys.sleep(0.1)
            next
        }
        if (Sys.time() >= deadline) {
            stop("Timed out waiting for another tool library setup. Its owner may have crashed; remove ",
                 shQuote(lock), " only after confirming its owner has exited.")
        }
        Sys.sleep(0.1)
    }
}

.tool_verify_child <- function(package, minimum_version, library) {
    code <- paste(
        "a <- commandArgs(TRUE); p <- a[1]; minimum <- a[2]; lib <- a[3];",
        "ns <- loadNamespace(p, lib.loc=lib);",
        "stopifnot(normalizePath(getNamespaceInfo(ns,'path')) == normalizePath(file.path(lib,p)));",
        "stopifnot(utils::compareVersion(as.character(utils::packageVersion(p,lib.loc=lib)),minimum) >= 0)"
    )
    status <- system2(file.path(R.home("bin"), "R"),
                      c("--vanilla", "--slave", "-e", shQuote(code), "--args",
                        shQuote(package), shQuote(minimum_version), shQuote(library)))
    if (!identical(as.integer(status), 0L)) {
        stop("The installed ", package, " package failed its compatibility/load check.")
    }
    invisible(TRUE)
}

# Install only after the caller has obtained consent. The repository is selected
# by the R session; callers cannot supply package archives or arbitrary URLs.
# Updating a shared library while another R process has loaded its package can
# fail (notably on Windows) or damage files. No process-use registry is kept;
# callers should close other R sessions using the package and retry on failure.
tool_library_install <- function(package, minimum_version, root,
                                 repos = getOption("repos"), timeout_seconds = 300) {
    .tool_validate_request(package, minimum_version)
    initial <- tool_library_check(package, minimum_version, root)
    if (!initial$install_required) return(invisible(initial))
    if (!is.character(repos)) {
        stop("No R package repository is configured for the managed tool library.")
    }
    repositories <- repos[!is.na(repos) & nzchar(repos) & repos != "@CRAN@"]
    if (length(repositories) == 0L) stop("No usable R package repository is configured.")
    package_type <- getOption("pkgType")
    package_types <- if (identical(package_type, "both")) {
        binary_type <- if (.Platform$OS.type == "windows") "win.binary" else .Platform$pkgType
        c(binary_type, "source")
    } else {
        package_type
    }
    candidates <- lapply(package_types, function(type) {
        available <- tryCatch(utils::available.packages(repos = repositories, type = type),
                              error = function(e) matrix(character(), nrow = 0L))
        list(type = type, available = available)
    })
    selected <- NULL
    for (candidate in candidates) {
        available <- candidate$available
        if (!package %in% rownames(available)) next
        candidate_version <- available[package, "Version"]
        if (.tool_version_ok(candidate_version, minimum_version)) {
            selected <- candidate
            break
        }
    }
    if (is.null(selected)) {
        stop("No configured repository version satisfies the requested minimum version.")
    }
    package_type <- selected$type
    available <- selected$available
    row <- available[package, , drop = TRUE]
    library <- initial$library
    .tool_with_library_lock(library, {
        current <- tool_library_check(package, minimum_version, root)
        if (!current$install_required) return(invisible(current))
        description <- as.data.frame(as.list(row), stringsAsFactors = FALSE)
        if (!.tool_dependencies_allowed(description)) {
            stop("Refusing to install ", package,
                 " because it has non-base package dependencies.")
        }
        updating <- !is.null(current$version)
        dir.create(library, recursive = TRUE, showWarnings = FALSE)
        if (file.access(library, 2L) != 0L) stop("The vscode-R managed tool library is not writable.")
        tryCatch({
            utils::install.packages(package, lib = library, repos = repositories,
                                    available = available, dependencies = FALSE,
                                    type = package_type, quiet = TRUE)
            version <- .tool_version_at(package, library)
            if (!.tool_version_ok(version, minimum_version)) {
                stop("The repository version does not satisfy the requested minimum version.")
            }
            .tool_verify_child(package, minimum_version, library)
            invisible(list(package = package, version = version, source = "managed",
                           install_required = FALSE, library = library))
        }, error = function(error) {
            action <- if (updating) "update" else "install"
            advice <- if (updating) "Close other R sessions using it and try again. " else ""
            stop("Could not ", action, " the managed ", package, " package. ", advice,
                 conditionMessage(error), call. = FALSE)
        })
    }, timeout_seconds = timeout_seconds)
}

# Load a compatible namespace according to the agreed precedence. Returns the
# loaded namespace, or NULL when installation is needed or an incompatible
# namespace is already loaded. The latter is left untouched for safe fallback.
tool_library_load <- function(package, minimum_version, root) {
    selected <- tool_library_check(package, minimum_version, root)
    if (selected$source == "loaded-incompatible") {
        message("An incompatible ", package,
                " namespace is already loaded. Restart R before using the managed version.")
        return(NULL)
    }
    if (selected$source == "loaded") return(asNamespace(package))
    if (selected$install_required) return(NULL)
    namespace <- loadNamespace(package, lib.loc = selected$library)
    actual_path <- normalizePath(getNamespaceInfo(namespace, "path"), winslash = "/", mustWork = TRUE)
    intended_path <- normalizePath(file.path(selected$library, package), winslash = "/", mustWork = TRUE)
    actual_version <- as.character(getNamespaceVersion(namespace))
    if (!identical(actual_path, intended_path) || !.tool_version_ok(actual_version, minimum_version)) {
        stop("Loaded ", package, " does not match the selected compatible library.")
    }
    namespace
}
