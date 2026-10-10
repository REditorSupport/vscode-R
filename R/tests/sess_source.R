# Base-R regression tests; no external packages or editor binary are needed.
source("R/sess_source.R")

field <- "Config/vscode-R/source-revision"
stable <- paste0("git-tree:", strrep("a", 40))
pre_release <- paste0("git-tree:", strrep("b", 40))
root <- tempfile("sess-source-")
dir.create(root)
on.exit(unlink(root, recursive = TRUE), add = TRUE)

write_description <- function(pkg, version, revision = NULL, imports = NULL) {
    dir.create(pkg, recursive = TRUE, showWarnings = FALSE)
    lines <- c("Package: sess", paste0("Version: ", version))
    if (!is.null(revision)) lines <- c(lines, paste0(field, ": ", revision))
    if (!is.null(imports)) lines <- c(lines, paste0("Imports: ", imports))
    writeLines(lines, file.path(pkg, "DESCRIPTION"))
}

# Installed metadata is read from library directories without loading sess.
bundled <- file.path(root, "bundled", "sess")
project_library <- file.path(root, "project library")
user_library <- file.path(root, "user library")
dir.create(bundled, recursive = TRUE)
dir.create(file.path(project_library, "sess"), recursive = TRUE)
dir.create(file.path(user_library, "sess"), recursive = TRUE)
write_description(bundled, "3.0.1", stable)
write_description(file.path(project_library, "sess"), "3.0.1", pre_release)
write_description(file.path(user_library, "sess"), "99.0.0", stable)

original_libs <- .libPaths()
on.exit(.libPaths(original_libs), add = TRUE)
.libPaths(c(project_library, user_library, original_libs))
stopifnot(!sess_install_required(bundled)) # Exact revision in any normal library wins.
stopifnot(identical(sess_find_source_library(stable), user_library))
stopifnot(identical(.libPaths()[1:2], c(project_library, user_library)))

write_description(file.path(user_library, "sess"), "99.0.0", pre_release)
stopifnot(sess_install_required(bundled)) # Mismatch does not count as bundled source.
unlink(file.path(project_library, "sess"), recursive = TRUE)
unlink(file.path(user_library, "sess"), recursive = TRUE)
stopifnot(sess_install_required(bundled)) # Missing source requires preparation.
stopifnot(!dir.exists(file.path(project_library, "sess")))
stopifnot(!dir.exists(file.path(user_library, "sess")))
write_description(bundled, "3.0.2", pre_release)
write_description(file.path(user_library, "sess"), "3.0.1", stable)
stopifnot(sess_install_required(bundled)) # Stable/pre-release revisions differ exactly.
write_description(file.path(user_library, "sess"), "99.0.0", pre_release)
stopifnot(!sess_install_required(bundled)) # Version is independent of source identity.
for (invalid in c("", "unknown", "git-tree:123")) {
    write_description(file.path(user_library, "sess"), "99.0.0", invalid)
    stopifnot(sess_install_required(bundled))
}
write_description(bundled, "3.0.2")
stopifnot(inherits(tryCatch(sess_install_required(bundled), error = identity), "error"))
write_description(bundled, "3.0.1", stable)

# Runtime-specific managed paths include the R platform and major/minor version.
managed_root <- file.path(root, "vscode-R managed")
identity <- sess_runtime_identity()
minor <- strsplit(R.version$minor, ".", fixed = TRUE)[[1L]][1L]
runtime_version <- paste(R.version$major, minor, sep = ".")
expected_identity <- paste(R.version$platform, runtime_version, sep = "|")
stopifnot(identical(identity, expected_identity))
managed_library <- sess_managed_library(managed_root, stable)
stopifnot(identical(managed_library, file.path(managed_root, R.version$platform,
                                               runtime_version, strrep("a", 40), "library")))

# Install a dependency-free fixture into the managed library, then verify that
# explicit namespace loading selects it without changing ordinary .libPaths().
extension <- file.path(root, "extension with spaces")
pkg <- file.path(extension, "dist", "resources", "sess")
dir.create(file.path(pkg, "R"), recursive = TRUE)
dependency <- file.path(root, "sessfixturedep")
dir.create(file.path(dependency, "R"), recursive = TRUE)
writeLines(c(
    "Package: sessfixturedep",
    "Version: 1.0.0",
    "Title: Source Identity Dependency Test",
    "Description: A dependency-free test dependency.",
    "License: MIT",
    "Author: Test Author",
    "Maintainer: Test Author <test@example.com>"
), file.path(dependency, "DESCRIPTION"))
writeLines("fixture_value <- function() 'normal-library-dependency'", file.path(dependency, "R", "api.R"))
writeLines("export(fixture_value)", file.path(dependency, "NAMESPACE"))
utils::install.packages(dependency, repos = NULL, type = "source", lib = user_library,
                        quiet = TRUE)
write_description(pkg, "3.0.1", stable, imports = "sessfixturedep")
cat(paste0(
    "Title: Source Identity Test\n",
    "Description: A dependency-free installation fixture.\n",
    "License: MIT\n",
    "Author: Test Author\n",
    "Maintainer: Test Author <test@example.com>\n"
), file = file.path(pkg, "DESCRIPTION"), append = TRUE)
writeLines(c(
    "connect <- function(...) sessfixturedep::fixture_value()",
    "notify_client <- function(...) NULL",
    "request_client <- function(...) NULL"
), file.path(pkg, "R", "api.R"))
writeLines(c("export(connect)", "export(notify_client)", "export(request_client)",
             "importFrom(sessfixturedep,fixture_value)"),
           file.path(pkg, "NAMESPACE"))

install_sess_script <- file.path(extension, "R", "install_sess.R")
dir.create(dirname(install_sess_script), recursive = TRUE)
for (script in c("install_sess.R", "sess_source.R", "sess-package-install.R")) {
    stopifnot(file.copy(file.path("R", script), file.path(dirname(install_sess_script), script)))
}

ordinary_before <- .libPaths()
previous_r_libs <- Sys.getenv("R_LIBS", unset = NA_character_)
Sys.setenv(R_LIBS = paste(ordinary_before, collapse = .Platform$path.sep))
inherited_library <- file.path(root, "must not be used")
r_binary <- file.path(R.home("bin"), if (.Platform$OS.type == "windows") "R.exe" else "R")
stopifnot(sess_install_required(bundled))
existing_user_sess <- readLines(file.path(user_library, "sess", "DESCRIPTION"))
Sys.unsetenv("VSCODE_R_SESS_LIBRARY")
refusal <- suppressWarnings(system2(r_binary, shQuote(c(
    "--vanilla", "--silent", "--no-echo", "--no-save", "--no-restore",
    paste0("--file=", install_sess_script), "--args", pkg, "https://example.com"
)), stdout = TRUE, stderr = TRUE))
stopifnot(!is.null(attr(refusal, "status")), attr(refusal, "status") != 0L)
stopifnot(identical(readLines(file.path(user_library, "sess", "DESCRIPTION")), existing_user_sess))
stopifnot(!dir.exists(inherited_library))

Sys.setenv(VSCODE_R_SESS_PKG_PATH = pkg,
           VSCODE_R_SESS_REPO = "https://example.com",
           VSCODE_R_SESS_LIBRARY = inherited_library,
           VSCODE_R_SESS_INTERACTIVE = "0")
output <- suppressWarnings(system2(r_binary, shQuote(c(
    "--vanilla", "--silent", "--no-echo", "--no-save", "--no-restore",
    paste0("--file=", install_sess_script), "--args", pkg,
    "https://example.com", managed_library
)), stdout = TRUE, stderr = TRUE))
if (!is.null(attr(output, "status")) && attr(output, "status") != 0L) {
    stop(paste(output, collapse = "\n"))
}
stopifnot(file.exists(file.path(managed_library, "sess", "DESCRIPTION")))
stopifnot(!dir.exists(file.path(managed_library, "sessfixturedep")))
stopifnot(!dir.exists(file.path(inherited_library, "sess")))
stopifnot(identical(readLines(file.path(user_library, "sess", "DESCRIPTION")), existing_user_sess))
stopifnot(identical(.libPaths(), ordinary_before))

# A mismatching namespace already loaded from a project library must survive a
# managed-load refusal. The profile must also stop before connecting the watcher.
write_description(pkg, "3.0.1", pre_release, imports = "sessfixturedep")
utils::install.packages(pkg, repos = NULL, type = "source", lib = project_library, quiet = TRUE)
write_description(pkg, "3.0.1", stable, imports = "sessfixturedep")
child <- file.path(root, "check-loaded-mismatch.R")
writeLines(c(
    "args <- commandArgs(TRUE)",
    "source(args[1])",
    "normal <- strsplit(args[5], .Platform$path.sep, fixed=TRUE)[[1]]",
    ".libPaths(normal)",
    "loadNamespace('sess', lib.loc=normal)",
    "expected <- args[3]; mismatch <- args[4]",
    "err <- tryCatch(sess_load_namespace(args[2], expected, normal), error=identity)",
    "stopifnot(inherits(err, 'error'), identical(sess_loaded_source_revision(), mismatch))",
    "Sys.setenv(VSCODE_R_SESS_PKG_PATH=args[6], VSCODE_R_SESS_SOURCE_HELPER=args[1], VSCODE_R_SESS_ROOT=args[7])",
    "messages <- character()",
    "withCallingHandlers(source(args[8]), message=function(m) { messages <<- c(messages, conditionMessage(m)); invokeRestart('muffleMessage') })",
    "stopifnot(any(grepl('different sess namespace is already loaded', messages)), identical(sess_loaded_source_revision(), mismatch))",
    "stopifnot(identical(.libPaths(), normal))"
), child)
profile <- file.path("R", "profile.R")
child_output <- suppressWarnings(system2(r_binary, shQuote(c(
    "--vanilla", "--silent", "--no-echo", "--no-save", "--no-restore",
    paste0("--file=", child), "--args",
    file.path(getwd(), "R", "sess_source.R"), managed_library, stable, pre_release,
    paste(ordinary_before, collapse = .Platform$path.sep), pkg, managed_root,
    file.path(getwd(), profile)
)), stdout = TRUE, stderr = TRUE))
if (!is.null(attr(child_output, "status")) && attr(child_output, "status") != 0L) {
    stop(paste(child_output, collapse = "\n"))
}

# Metadata queries and explicit load target the intended copy. The package is
# loaded only after installation, and the user's search path remains untouched.
stopifnot(!"sess" %in% loadedNamespaces())
stopifnot(identical(sess_installed_source_revision(managed_library), stable))
ns <- sess_load_namespace(managed_library, stable, normal_libraries = ordinary_before)
loaded_path <- normalizePath(getNamespaceInfo(ns, "path"), winslash = "/")
intended_path <- normalizePath(file.path(managed_library, "sess"), winslash = "/")
stopifnot(identical(loaded_path, intended_path))
stopifnot(identical(sess_loaded_source_revision(), stable))
stopifnot(identical(getExportedValue("sess", "connect")(), "normal-library-dependency"))
stopifnot(identical(.libPaths(), ordinary_before))

Sys.unsetenv(c("VSCODE_R_SESS_PKG_PATH", "VSCODE_R_SESS_REPO",
               "VSCODE_R_SESS_LIBRARY", "VSCODE_R_SESS_INTERACTIVE"))
if (is.na(previous_r_libs)) Sys.unsetenv("R_LIBS") else Sys.setenv(R_LIBS = previous_r_libs)
unlink(root, recursive = TRUE)
cat("sess source identity and managed installer tests passed\n")
