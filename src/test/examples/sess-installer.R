local({
    # The staged bundle carries the same source stamp as a packaged extension.
    # Imports must already be present: this test disables compilation only to
    # prove that the pure-R sess package itself does not invoke a compiler.
    root <- normalizePath(commandArgs(TRUE)[[1L]])
    package <- file.path(root, "dist", "resources", "sess")
    stopifnot(file.exists(file.path(package, "DESCRIPTION")))
    description <- read.dcf(file.path(package, "DESCRIPTION"))
    deps <- if ("Imports" %in% colnames(description)) description[1L, "Imports"] else ""
    deps <- trimws(gsub("\\s*\\(.*\\)", "", unlist(strsplit(deps, ","))))
    installed <- utils::installed.packages(lib.loc = .libPaths())
    missing <- setdiff(deps[nzchar(deps)], rownames(installed))
    stopifnot(!length(missing))

    installer <- new.env(parent = baseenv())
    sys.source(file.path(root, "R", "sess-package-install.R"), installer)
    fail <- function(code, pattern) {
        error <- tryCatch({
            force(code)
            NULL
        }, error = conditionMessage)
        stopifnot(is.character(error), grepl(pattern, error))
        error
    }

    temporary <- tempfile("sess installer ")
    dir.create(temporary)
    previous_directory <- setwd(temporary)
    on.exit({
        setwd(previous_directory)
        unlink(temporary, recursive = TRUE)
    }, add = TRUE)
    makevars <- file.path(temporary, "No compiler")
    writeLines(c("CC=compiler-is-not-installed", "CXX=compiler-is-not-installed"), makevars)
    previous_makevars <- Sys.getenv("R_MAKEVARS_USER", unset = NA_character_)
    Sys.setenv(R_MAKEVARS_USER = makevars)
    on.exit(if (is.na(previous_makevars)) Sys.unsetenv("R_MAKEVARS_USER") else
        Sys.setenv(R_MAKEVARS_USER = previous_makevars), add = TRUE)

    target <- file.path(temporary, "target library")
    dir.create(target)
    environment_before <- Sys.getenv(c("R_LIBS", "R_PROFILE_USER", "R_ENVIRON_USER"), unset = NA_character_)
    installer$sess_install(package, target, "https://unused.invalid", interactive = TRUE)
    stopifnot(identical(environment_before,
                        Sys.getenv(c("R_LIBS", "R_PROFILE_USER", "R_ENVIRON_USER"), unset = NA_character_)))
    stopifnot(file.exists(file.path(target, "sess", "DESCRIPTION")))
    cat("Bundled pure R source installation and Interactive API verification passed.\n")

    ordinary_target <- file.path(temporary, "ordinary target library")
    dir.create(ordinary_target)
    installer$sess_install(package, ordinary_target, "https://unused.invalid", interactive = FALSE)
    stopifnot(file.exists(file.path(ordinary_target, "sess", "DESCRIPTION")))
    cat("Bundled pure R source installation for an ordinary R terminal passed.\n")
    expected_revision <- description[1L, "Config/vscode-R/source-revision"]

    # --vanilla verification inherits R_DEFAULT_PACKAGES. Ordinary projects may
    # attach utils from .Rprofile while requesting only base by default.
    previous_default_packages <- Sys.getenv("R_DEFAULT_PACKAGES", unset = NA_character_)
    Sys.setenv(R_DEFAULT_PACKAGES = "base")
    tryCatch({
        installer$sess_verify_package(ordinary_target, description[1L, "Version"], expected_revision, FALSE)
        installer$sess_verify_package(target, description[1L, "Version"], expected_revision, TRUE)
    }, finally = {
        if (is.na(previous_default_packages)) Sys.unsetenv("R_DEFAULT_PACKAGES") else
            Sys.setenv(R_DEFAULT_PACKAGES = previous_default_packages)
    })
    stopifnot(identical(previous_default_packages, Sys.getenv("R_DEFAULT_PACKAGES", unset = NA_character_)))
    cat("Ordinary and Interactive verification works with only base default packages.\n")

    # The shared verifier enforces the exact bundled revision for ordinary and
    # private runtime installation paths.
    wrong_revision <- paste0("git-tree:", strrep("0", 40))
    if (identical(expected_revision, wrong_revision)) wrong_revision <- paste0("git-tree:", strrep("1", 40))
    fail(installer$sess_verify_package(ordinary_target, description[1L, "Version"], wrong_revision, FALSE),
         "compatibility/load check")
    fail(installer$sess_verify_package(target, description[1L, "Version"], wrong_revision, TRUE),
         "compatibility/load check")
    cat("Exact source-revision mismatch rejected for ordinary and private verification.\n")

    # Missing Imports are sent to install.packages() with the selected library
    # and configured repository; its error is allowed to propagate unchanged.
    dependency_root <- file.path(temporary, "dependency fixture")
    dir.create(dependency_root)
    stopifnot(file.copy(package, dependency_root, recursive = TRUE))
    dependency_package <- file.path(dependency_root, basename(package))
    dependency_description <- read.dcf(file.path(dependency_package, "DESCRIPTION"))
    missing_import <- paste0("vscodeRSessMissing", gsub("[^a-zA-Z0-9]", "", tempfile()))
    dependency_description[1L, "Imports"] <- missing_import
    write.dcf(dependency_description, file.path(dependency_package, "DESCRIPTION"))
    install_arguments <- NULL
    installer$sess_install_dependencies <- function(packages, library, repos) {
        install_arguments <<- list(packages = packages, library = library, repos = repos)
        stop("dependency install sentinel")
    }
    installer$sess_install_command <- function(...) stop("Bundled sess installation must not run")
    dependency_error <- fail(installer$sess_install(dependency_package, target, "https://configured.example"),
                             "dependency install sentinel")
    stopifnot(identical(dependency_error, "dependency install sentinel"),
              identical(install_arguments$packages, missing_import),
              identical(install_arguments$library, target),
              identical(install_arguments$repos, "https://configured.example"))
    cat("Missing Imports use the configured repository and propagate installation errors.\n")

    # A non-zero R CMD INSTALL result stops immediately and does not attempt
    # another sess source.
    installer$sess_install_dependencies <- function(...) stop("Dependencies are already available")
    installer$sess_install_command <- function(...) FALSE
    fail(installer$sess_install(package, target, "https://unused.invalid"), "Could not install bundled sess")
    cat("Bundled sess installation failure is reported directly.\n")
})
