# Base-R tests; no package dependencies or editor binary are needed.
source("R/sess_source.R")
field <- "Config/vscode-R/source-revision"
stable <- paste0("git-tree:", strrep("a", 40))
pre_release <- paste0("git-tree:", strrep("b", 40))
root <- tempfile("sess-source-")
dir.create(root)
dir.create(file.path(root, "bundled"))
dir.create(file.path(root, "installed"))
bundled <- file.path(root, "bundled")
installed <- file.path(root, "installed")
write_description <- function(pkg, version, revision = NULL) {
    lines <- c("Package: sess", paste0("Version: ", version))
    if (!is.null(revision)) {
        lines <- c(lines, paste0(field, ": ", revision))
    }
    writeLines(lines, file.path(pkg, "DESCRIPTION"))
}
# Control the selected installation, while exercising the real DCF reader.
selected <- character()
find.package <- function(package, lib.loc, quiet) {
    stopifnot(identical(package, "sess"), identical(lib.loc, .libPaths()), quiet)
    selected
}
write_description(bundled, "3.0.1", stable)
stopifnot(sess_install_required(bundled)) # Missing package.
selected <- installed
write_description(installed, "99.0.0")
stopifnot(sess_install_required(bundled)) # Legacy field missing, newer version.
write_description(installed, "3.0.1", pre_release)
stopifnot(sess_install_required(bundled)) # Same version, different source.
write_description(installed, "3.0.2", pre_release)
stopifnot(sess_install_required(bundled)) # Switching from pre-release back to stable.
write_description(bundled, "3.0.2", pre_release)
write_description(installed, "3.0.1", stable)
stopifnot(sess_install_required(bundled)) # Switching from stable to pre-release.
write_description(installed, "99.0.0", pre_release)
stopifnot(!sess_install_required(bundled)) # Same source, irrelevant version.
for (invalid in c("", "unknown", "git-tree:123")) {
    write_description(installed, "99.0.0", invalid)
    stopifnot(sess_install_required(bundled))
}
write_description(bundled, "3.0.2")
stopifnot(inherits(tryCatch(sess_install_required(bundled), error = identity), "error"))

# Exercise the real installer flow while replacing the package installation with
# controlled success/failure (install.packages can return after a warning).
extension <- file.path(root, "extension")
dir.create(extension)
dir.create(file.path(extension, "R"))
stopifnot(file.copy("R/sess_source.R", file.path(extension, "R", "sess_source.R")))
installer <- file.path(extension, "R", "install_sess.R")
stopifnot(file.copy("R/install_sess.R", installer))
pkg <- file.path(extension, "dist", "resources", "sess")
dir.create(pkg, recursive = TRUE)
write_description(pkg, "3.0.1", stable)
Sys.setenv(VSCODE_R_SESS_PKG_PATH = pkg, VSCODE_R_SESS_REPO = "https://example.com")
simulate <- function(outcome) {
    env <- new.env(parent = globalenv())
    env$install.packages <- function(pkgs, repos, type) {
        stopifnot(identical(pkgs, pkg), is.null(repos), identical(type, "source"))
        if (outcome == "success") {
            write_description(installed, "3.0.1", stable)
        } else if (outcome == "shadowed") {
            write_description(installed, "3.0.1", pre_release)
        } else {
            warning("Installation failed")
        }
    }
    suppressWarnings(tryCatch(source(installer, local = env), error = identity))
}
write_description(installed, "3.0.1", pre_release)
stopifnot(inherits(simulate("failure"), "error"))
stopifnot(inherits(simulate("shadowed"), "error"))
stopifnot(!inherits(simulate("success"), "error"))
stopifnot(!sess_install_required(pkg))
Sys.unsetenv(c("VSCODE_R_SESS_PKG_PATH", "VSCODE_R_SESS_REPO"))

# Verify actual R installation preserves the custom field and that querying
# installed metadata does not load the package or run its .onLoad hook.
rm(find.package)
library_path <- file.path(root, "library")
dir.create(library_path)
original_libs <- .libPaths()
.libPaths(c(library_path, original_libs))
write_description(pkg, "3.0.1", stable)
cat(paste0(
    "Title: Source Identity Test\n",
    "Description: A dependency-free installation fixture.\n",
    "License: MIT\n",
    "Author: Test Author\n",
    "Maintainer: Test Author <test@example.com>\n"
), file = file.path(pkg, "DESCRIPTION"), append = TRUE)
dir.create(file.path(pkg, "R"))
writeLines(".onLoad <- function(...) stop('Metadata lookup must not load sess')", file.path(pkg, "R", "zzz.R"))
writeLines("", file.path(pkg, "NAMESPACE"))
utils::install.packages(pkg, repos = NULL, type = "source", lib = library_path,
                        INSTALL_opts = "--no-test-load", quiet = TRUE)
stopifnot(identical(sess_installed_source_revision(), stable), !sess_install_required(pkg))
stopifnot(!"sess" %in% loadedNamespaces())
.libPaths(original_libs)

# Run the same R executable invocation as the managed installer, rather than
# source() (which supplies an ofile frame and hides command-line path failures).
local({
    project <- file.path(root, "project with spaces")
    cli_library <- file.path(project, "library")
    dir.create(cli_library, recursive = TRUE)
    writeLines(".libPaths(c(file.path(getwd(), \"library\"), .libPaths()))", file.path(project, ".Rprofile"))
    writeLines("NULL", file.path(pkg, "R", "zzz.R"))
    previous_profile <- Sys.getenv("R_PROFILE_USER", unset = NA_character_)
    previous_cwd <- getwd()
    on.exit({
        setwd(previous_cwd)
        if (is.na(previous_profile)) {
            Sys.unsetenv("R_PROFILE_USER")
        } else {
            Sys.setenv(R_PROFILE_USER = previous_profile)
        }
        .libPaths(original_libs)
    })
    Sys.unsetenv("R_PROFILE_USER")
    setwd(project)
    r_binary <- file.path(R.home("bin"), if (.Platform$OS.type == "windows") "R.exe" else "R")
    output <- suppressWarnings(system2(r_binary, shQuote(c(
        "--silent", "--no-echo", "--no-save", "--no-restore",
        paste0("--file=", installer), "--args", pkg, "https://example.com"
    )), stdout = TRUE, stderr = TRUE))
    if (!is.null(attr(output, "status")) && attr(output, "status") != 0L) {
        stop(paste(output, collapse = "\n"))
    }
    stopifnot(file.exists(file.path(cli_library, "sess", "DESCRIPTION")))
    .libPaths(c(cli_library, original_libs))
    stopifnot(identical(sess_installed_source_revision(), stable))
})
unlink(root, recursive = TRUE)
cat("sess source identity and installer tests passed\n")
