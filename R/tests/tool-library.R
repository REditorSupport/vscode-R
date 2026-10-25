# Base-R coverage for the managed tool library. All packages are local fixtures.
source("R/tool-library.R")

local({
    root <- tempfile("tool-library-")
    dir.create(root)
    on.exit(unlink(root, recursive = TRUE), add = TRUE)
    original_paths <- .libPaths()
    on.exit(.libPaths(original_paths), add = TRUE)

    write_package <- function(package, version, imports = NULL) {
        directory <- file.path(root, "source", package)
        dir.create(file.path(directory, "R"), recursive = TRUE, showWarnings = FALSE)
        fields <- c(paste0("Package: ", package), paste0("Version: ", version),
                    paste0("Title: ", package, " fixture"),
                    paste0("Description: Local test package for ", package, "."),
                    "License: MIT", "Author: Test Author",
                    "Maintainer: Test Author <test@example.com>", "Encoding: UTF-8")
        if (!is.null(imports)) fields <- c(fields, paste0("Imports: ", imports))
        writeLines(fields, file.path(directory, "DESCRIPTION"))
        writeLines("fixture_value <- function() 'managed'", file.path(directory, "R", "api.R"))
        writeLines("export(fixture_value)", file.path(directory, "NAMESPACE"))
        archive <- file.path(root, "repo", "src", "contrib")
        dir.create(archive, recursive = TRUE, showWarnings = FALSE)
        unlink(list.files(archive, pattern = paste0("^", package, "_.*\\.tar\\.gz$"), full.names = TRUE))
        previous <- setwd(dirname(directory))
        on.exit(setwd(previous), add = TRUE)
        result <- system2(file.path(R.home("bin"), "R"),
                          c("CMD", "build", "--no-build-vignettes", shQuote(basename(directory))),
                          stdout = TRUE, stderr = TRUE)
        status <- attr(result, "status")
        if (!is.null(status) && status != 0L) stop(paste(result, collapse = "\n"))
        built <- list.files(".", pattern = "\\.tar\\.gz$", full.names = TRUE)
        stopifnot(length(built) == 1L)
        stopifnot(file.copy(built, archive))
        unlink(built)
        setwd(previous)
        invisible(directory)
    }

    # Build a package with an external dependency and verify that it is rejected.
    write_package("jgddep", "1.0.0")
    write_package("jgd", "1.3.0", imports = "jgddep")
    tools::write_PACKAGES(file.path(root, "repo", "src", "contrib"), type = "source")
    repo <- paste0("file://", normalizePath(file.path(root, "repo"), winslash = "/"))
    previous_pkg_type <- getOption("pkgType")
    options(pkgType = "source")
    on.exit(options(pkgType = previous_pkg_type), add = TRUE)
    root_path <- file.path(root, "vscode-R")
    managed <- tool_library_path(root_path)
    stopifnot(identical(managed,
                        file.path(root_path, "packages", R.version$platform,
                                  paste(R.version$major,
                                        strsplit(R.version$minor, ".", fixed = TRUE)[[1L]][1L],
                                        sep = "."), "library")))

    project_library <- file.path(root, "project library")
    package_manager_library <- file.path(root, "package manager library")
    user_library <- file.path(root, "user library")
    dir.create(project_library)
    dir.create(package_manager_library)
    dir.create(user_library)
    .libPaths(c(project_library, package_manager_library, user_library, original_paths))
    before <- .libPaths()
    snapshot <- function(path) {
        files <- sort(list.files(path, recursive = TRUE, all.files = TRUE, no.. = TRUE))
        list(files = files, contents = unname(tools::md5sum(file.path(path, files))))
    }
    ordinary_libraries <- c(project_library, package_manager_library, user_library)
    for (library in ordinary_libraries) writeLines("Keep this file.", file.path(library, "sentinel"))
    ordinary_before <- lapply(ordinary_libraries, snapshot)
    stopifnot(tool_library_check("jgd", "1.0.0", root_path)$install_required)
    stopifnot(inherits(tryCatch(tool_library_check("arbitrary", "1.0.0", root_path),
                                error = identity), "error"))
    for (invalid in c("", "1.foo", "https://example.com/pkg")) {
        stopifnot(inherits(tryCatch(tool_library_check("jgd", invalid, root_path),
                                    error = identity), "error"))
    }
    for (field in c("Depends", "LinkingTo")) {
        description <- matrix("jgddep", nrow = 1L, dimnames = list(NULL, field))
        stopifnot(!.tool_dependencies_allowed(description))
    }
    stopifnot(.tool_dependencies_allowed(matrix("R (>= 4.0), stats", nrow = 1L,
                                                dimnames = list(NULL, "Depends"))))
    rejection <- tryCatch(tool_library_install("jgd", "1.3.0", root_path,
                                               repos = c(CRAN = repo)), error = identity)
    stopifnot(inherits(rejection, "error"), grepl("non-base package dependencies", conditionMessage(rejection)))
    stopifnot(!dir.exists(file.path(managed, "jgd")))

    # Replace it with a dependency-free package, then install without network access.
    write_package("jgd", "1.2.0")
    tools::write_PACKAGES(file.path(root, "repo", "src", "contrib"), type = "source")
    # The same verification failure must distinguish first installation from an update.
    failing_install <- tool_library_install
    environment(failing_install) <- list2env(list(
        .tool_verify_child = function(...) stop("fixture verification failure")
    ), parent = environment(tool_library_install))
    for (updating in c(FALSE, TRUE)) {
        failure_root <- file.path(root, if (updating) "failed update" else "failed installation")
        if (updating) {
            existing <- file.path(tool_library_path(failure_root), "jgd")
            dir.create(existing, recursive = TRUE)
            writeLines(c("Package: jgd", "Version: 0.1.0"), file.path(existing, "DESCRIPTION"))
        }
        failure <- tryCatch(failing_install("jgd", "1.0.0", failure_root, repos = c(CRAN = repo)),
                            error = identity)
        expected <- paste0("Could not ", if (updating) "update" else "install", " the managed jgd package. ",
                           if (updating) "Close other R sessions using it and try again. " else "",
                           "fixture verification failure")
        stopifnot(inherits(failure, "error"), identical(conditionMessage(failure), expected))
    }
    too_old <- tryCatch(tool_library_install("jgd", "1.3.0", root_path, repos = c(CRAN = repo)),
                        error = identity)
    stopifnot(inherits(too_old, "error"), !dir.exists(file.path(managed, "jgd")))
    result <- tool_library_install("jgd", "1.0.0", root_path, repos = c(CRAN = repo))
    stopifnot(identical(result$source, "managed"), identical(result$version, "1.2.0"))
    stopifnot(identical(.libPaths(), before))
    stopifnot(identical(tool_library_check("jgd", "1.0.0", root_path)$source, "managed"))
    stopifnot(identical(lapply(ordinary_libraries, snapshot), ordinary_before))
    no_update <- tool_library_install("jgd", "1.0.0", root_path, repos = character())
    stopifnot(identical(no_update$version, "1.2.0"))
    write_package("jgd", "1.4.0")
    tools::write_PACKAGES(file.path(root, "repo", "src", "contrib"), type = "source")
    upgrade <- tool_library_install("jgd", "1.3.0", root_path, repos = c(CRAN = repo))
    stopifnot(identical(upgrade$version, "1.4.0"))
    stopifnot(identical(lapply(ordinary_libraries, snapshot), ordinary_before), identical(.libPaths(), before))

    lock_path <- file.path(dirname(managed), ".setup-lock")
    stopifnot(isTRUE(.tool_with_library_lock(managed, dir.exists(lock_path))))
    stopifnot(!dir.exists(lock_path))
    owner_error <- tryCatch(.tool_with_library_lock(managed, stop("fixture failure")), error = identity)
    stopifnot(inherits(owner_error, "error"), !dir.exists(lock_path))
    dir.create(lock_path)
    lock_timeout <- tryCatch(.tool_with_library_lock(managed, TRUE, timeout_seconds = 0),
                             error = identity)
    stopifnot(inherits(lock_timeout, "error"), dir.exists(lock_path))
    unlink(lock_path, recursive = TRUE)

    # A compatible ordinary library copy wins over the managed one.
    utils::install.packages(file.path(root, "source", "jgd"), repos = NULL,
                            type = "source", lib = user_library, quiet = TRUE)
    .libPaths(c(user_library, .Library))
    user_paths <- .libPaths()
    user_choice <- tool_library_check("jgd", "1.0.0", root_path)
    stopifnot(identical(user_choice$source, "user"))
    user_namespace <- tool_library_load("jgd", "1.0.0", root_path)
    stopifnot(identical(normalizePath(getNamespaceInfo(user_namespace, "path"), winslash = "/"),
                        normalizePath(file.path(user_library, "jgd"), winslash = "/")))
    stopifnot(identical(.libPaths(), user_paths))
    unloadNamespace("jgd")
    .libPaths(setdiff(before, user_library))
    managed_paths <- .libPaths()
    namespace <- tool_library_load("jgd", "1.0.0", root_path)
    stopifnot(identical(getExportedValue("jgd", "fixture_value")(), "managed"))
    stopifnot(identical(normalizePath(getNamespaceInfo(namespace, "path"), winslash = "/"),
                        normalizePath(file.path(managed, "jgd"), winslash = "/")))
    stopifnot(is.null(tool_library_load("jgd", "2.0.0", root_path)))
    child_rejection <- tryCatch(.tool_verify_child("jgd", "2.0.0", managed), error = identity)
    stopifnot(inherits(child_rejection, "error"))
    stopifnot(identical(.libPaths(), managed_paths))

    cat("managed tool library tests passed\n")
})
