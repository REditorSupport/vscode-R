# Base-R integration coverage for manual attach consent; all packages are local fixtures.
source("R/sess_source.R")
root <- tempfile("attach-sess-")
dir.create(root)
on.exit(unlink(root, recursive = TRUE), add = TRUE)

revision <- paste0("git-tree:", strrep("a", 40))
mismatch <- paste0("git-tree:", strrep("b", 40))
pkg <- file.path(root, "bundled", "sess")
dir.create(file.path(pkg, "R"), recursive = TRUE)
writeLines(c(
    "Package: sess", "Version: 1.0.0", "Title: Manual Attach Consent Fixture",
    "Description: A local fixture for manual attach consent.", "License: MIT",
    "Author: Test Author", "Maintainer: Test Author <test@example.com>",
    paste0("Config/vscode-R/source-revision: ", revision)
), file.path(pkg, "DESCRIPTION"))
writeLines(c(
    "connect <- function(endpoint=NULL, plot_backend=NULL, ...) list(",
    "  endpoint=endpoint, plot_backend=plot_backend, ...)",
    "notify_client <- function(...) NULL", "request_client <- function(...) NULL"
), file.path(pkg, "R", "api.R"))
writeLines(c("export(connect)", "export(notify_client)", "export(request_client)"),
           file.path(pkg, "NAMESPACE"))

runner <- file.path(root, "run-case.R")
writeLines(c(
    "args <- commandArgs(TRUE)",
    "mode <- args[[1L]]; root <- args[[2L]]; pkg <- args[[3L]]",
    "revision <- args[[4L]]; mismatch <- args[[5L]]",
    "source(file.path(getwd(), 'R', 'sess_source.R'))",
    "source(file.path(getwd(), 'R', 'attach_sess.R'))",
    "normal <- file.path(root, 'normal library')",
    "dir.create(normal, recursive=TRUE, showWarnings=FALSE)",
    "consent <- file.path(root, 'consent')",
    "dir.create(consent, recursive=TRUE, showWarnings=FALSE)",
    "managed_root <- file.path(root, 'vscode-R')",
    "project_library <- file.path(root, 'project library')",
    "Sys.setenv(R_LIBS_USER=file.path(root, 'empty user library'), R_LIBS_SITE=.Library)",
    "profile_mode <- startsWith(mode, 'profile_')",
    "if (!profile_mode) .libPaths(c(normal, .Library))",
    "ordinary <- .libPaths()",
    "same_paths <- function(x, y) identical(normalizePath(x, winslash='/'),",
    "                                     normalizePath(y, winslash='/'))",
    "attach_sess <- function(timeout=180) {",
    "  vscode_r_attach_sess('endpoint', pkg, managed_root, consent,",
    "    file.path(getwd(), 'R', 'sess_source.R'),",
    "    file.path(getwd(), 'R', 'sess-package-install.R'),",
    "    'standard', timeout_seconds=timeout)",
    "}",
    "if (mode %in% c('exact', 'prepared')) {",
    "  expected <- if (mode == 'exact') normal else",
    "    sess_managed_library(managed_root, revision)",
    "  dir.create(expected, recursive=TRUE, showWarnings=FALSE)",
    "  utils::install.packages(pkg, repos=NULL, type='source', lib=expected, quiet=TRUE)",
    "  result <- attach_sess(timeout=0)",
    "  stopifnot(identical(result, TRUE), same_paths(.libPaths(), ordinary))",
    "  stopifnot(identical(sess_loaded_source_revision(), revision))",
    "  actual <- getNamespaceInfo(asNamespace('sess'), 'path')",
    "  stopifnot(same_paths(actual, file.path(expected, 'sess')))",
    "  stopifnot(length(list.files(consent, pattern='\\\\.request$')) == 0L)",
    "} else if (mode == 'twice') {",
    "  for (iteration in 1:2) {",
    "    set.seed(8841); seed <- .Random.seed",
    "    result <- attach_sess(timeout=8)",
    "    stopifnot(identical(result, FALSE), identical(seed, .Random.seed))",
    "    stopifnot(same_paths(.libPaths(), ordinary))",
    "  }",
    "  stopifnot(!dir.exists(file.path(normal, 'sess')))",
    "  stopifnot(!dir.exists(sess_managed_library(managed_root, revision)))",
    "} else if (mode == 'mismatch') {",
    "  utils::install.packages(pkg, repos=NULL, type='source', lib=normal, quiet=TRUE)",
    "  desc_path <- file.path(normal, 'sess', 'DESCRIPTION')",
    "  desc <- read.dcf(desc_path)",
    "  desc[1L, 'Config/vscode-R/source-revision'] <- mismatch",
    "  write.dcf(desc, desc_path)",
    "  set.seed(8841); seed <- .Random.seed",
    "  result <- attach_sess(timeout=8)",
    "  stopifnot(identical(result, FALSE), identical(seed, .Random.seed))",
    "  stopifnot(same_paths(.libPaths(), ordinary))",
    "  stopifnot(identical(read.dcf(desc_path), desc))",
    "  stopifnot(!dir.exists(sess_managed_library(managed_root, revision)))",
    "} else if (mode %in% c('profile_exact', 'profile_prepared')) {",
    "  expected <- if (mode == 'profile_exact') normal else",
    "    sess_managed_library(managed_root, revision)",
    "  stopifnot('sess' %in% loadedNamespaces())",
    "  stopifnot(identical(sess_loaded_source_revision(), revision))",
    "  stopifnot(same_paths(.libPaths(), ordinary))",
    "  actual <- getNamespaceInfo(asNamespace('sess'), 'path')",
    "  stopifnot(same_paths(actual, file.path(expected, 'sess')))",
    "  baseline <- readRDS(file.path(root, 'profile-libraries.rds'))",
    "  if (!same_paths(.libPaths(), baseline)) stop(paste('library paths differ:',",
    "    paste(normalizePath(baseline), collapse=';'), 'vs',",
    "    paste(normalizePath(.libPaths()), collapse=';')))",
    "  stopifnot(file.exists(file.path(root, 'user-profile-ran')))",
    "  stopifnot(any(normalizePath(.libPaths()) == normalizePath(project_library)))",
    "  stopifnot(length(list.files(consent, pattern='\\\\.request$')) == 0L)",
    "} else if (mode == 'profile_decline') {",
    "  wrong_library <- file.path(managed_root, 'fixture-other-platform',",
    "                             '99.99', strrep('a', 40), 'library')",
    "  stopifnot(!('sess' %in% loadedNamespaces()))",
    "  stopifnot(same_paths(.libPaths(), ordinary))",
    "  baseline <- readRDS(file.path(root, 'profile-libraries.rds'))",
    "  if (!same_paths(.libPaths(), baseline)) stop(paste('library paths differ:',",
    "    paste(normalizePath(baseline), collapse=';'), 'vs',",
    "    paste(normalizePath(.libPaths()), collapse=';')))",
    "  stopifnot(file.exists(file.path(root, 'user-profile-ran')))",
    "  stopifnot(!dir.exists(sess_managed_library(managed_root, revision)))",
    "  stopifnot(file.exists(file.path(wrong_library, 'sess', 'DESCRIPTION')))",
    "  stopifnot(length(list.files(consent, pattern='\\\\.request$')) == 0L)",
    "} else if (mode == 'profile_approve') {",
    "  wrong_library <- file.path(managed_root, 'fixture-other-platform',",
    "                             '99.99', strrep('a', 40), 'library')",
    "  library <- sess_managed_library(managed_root, revision)",
    "  stopifnot('sess' %in% loadedNamespaces())",
    "  stopifnot(identical(sess_loaded_source_revision(), revision))",
    "  stopifnot(same_paths(.libPaths(), ordinary))",
    "  baseline <- readRDS(file.path(root, 'profile-libraries.rds'))",
    "  if (!same_paths(.libPaths(), baseline)) stop(paste('library paths differ:',",
    "    paste(normalizePath(baseline), collapse=';'), 'vs',",
    "    paste(normalizePath(.libPaths()), collapse=';')))",
    "  stopifnot(file.exists(file.path(root, 'user-profile-ran')))",
    "  actual <- getNamespaceInfo(asNamespace('sess'), 'path')",
    "  stopifnot(same_paths(actual, file.path(library, 'sess')))",
    "  stopifnot(file.exists(file.path(library, 'sess', 'DESCRIPTION')))",
    "  stopifnot(file.exists(file.path(wrong_library, 'sess', 'DESCRIPTION')))",
    "} else if (mode == 'timeout') {",
    "  set.seed(8841); seed <- .Random.seed",
    "  result <- attach_sess(timeout=0)",
    "  stopifnot(identical(result, FALSE), identical(seed, .Random.seed))",
    "  stopifnot(same_paths(.libPaths(), ordinary))",
    "  stopifnot(!dir.exists(sess_managed_library(managed_root, revision)))",
    "  stopifnot(length(list.files(consent, pattern='\\\\.request$')) == 0L)",
    "} else if (mode == 'approve') {",
    "  wrong_library <- file.path(managed_root, 'fixture-other-platform',",
    "                             '99.99', strrep('a', 40), 'library')",
    "  dir.create(wrong_library, recursive=TRUE, showWarnings=FALSE)",
    "  utils::install.packages(pkg, repos=NULL, type='source',",
    "                          lib=wrong_library, quiet=TRUE)",
    "  set.seed(8841); seed <- .Random.seed",
    "  result <- attach_sess(timeout=20)",
    "  library <- sess_managed_library(managed_root, revision)",
    "  stopifnot(identical(result, TRUE), identical(seed, .Random.seed))",
    "  stopifnot(same_paths(.libPaths(), ordinary))",
    "  stopifnot(identical(sess_loaded_source_revision(), revision))",
    "  actual <- getNamespaceInfo(asNamespace('sess'), 'path')",
    "  stopifnot(same_paths(actual, file.path(library, 'sess')))",
    "  stopifnot(file.exists(file.path(library, 'sess', 'DESCRIPTION')))",
    "  stopifnot(!dir.exists(file.path(normal, 'sess')))",
    "  wrong_desc <- file.path(wrong_library, 'sess', 'DESCRIPTION')",
    "  stopifnot(file.exists(wrong_desc))",
    "  stopifnot(identical(sess_source_revision(wrong_desc), revision))",
    "} else stop('unknown case')",
    "cat('manual attach case passed:', mode, '\\n')"
), runner)

agent <- file.path(root, "consent-agent.R")
writeLines(c(
    "args <- commandArgs(TRUE)",
    "directory <- args[[1L]]; count <- as.integer(args[[2L]])",
    "answer <- args[[3L]]; log <- args[[4L]]; identity_log <- args[[5L]]",
    "status_log <- args[[6L]]",
    "tryCatch({",
    "ids <- character(); identities <- character(); deadline <- Sys.time() + 30",
    "while (length(ids) < count && Sys.time() < deadline) {",
    "  requests <- list.files(directory, pattern='\\\\.request$', full.names=TRUE)",
    "  for (request in requests) {",
    "    lines <- readLines(request, warn=FALSE)",
    "    if (length(lines) != 5L || lines[[1L]] != 'vscode-r-sess-consent-v1') stop('bad request')",
    "    id <- lines[[2L]]; if (id %in% ids) next",
    "    ids <- c(ids, id); temporary <- tempfile(tmpdir=directory)",
    "    identities <- c(identities, lines[[4L]])",
    "    writeLines(answer, temporary)",
    "    response <- file.path(directory, paste0(id, '.response'))",
    "    if (!file.rename(temporary, response)) stop('response rename failed')",
    "  }",
    "  Sys.sleep(0.025)",
    "}",
    "if (length(ids) != count) stop('timed out waiting for consent requests')",
    "writeLines(ids, log)",
    "writeLines(identities, identity_log)",
    "writeLines('ok', status_log)",
    "}, error=function(e) {",
    "writeLines(paste0('error: ', conditionMessage(e)), status_log)",
    "})"
), agent)

r_binary <- file.path(R.home("bin"), if (.Platform$OS.type == "windows") "R.exe" else "R")
r_literal <- function(value) encodeString(value, quote = "\"")
run_case <- function(mode) {
    case_root <- file.path(root, mode)
    dir.create(case_root)
    consent <- file.path(case_root, "consent")
    dir.create(consent)
    profile_modes <- c(
                       "profile_exact", "profile_prepared", "profile_decline", "profile_approve")
    startup <- mode %in% profile_modes
    if (startup) {
        normal <- file.path(case_root, "normal library")
        project <- file.path(case_root, "project library")
        managed_root <- file.path(case_root, "vscode-R")
        dir.create(normal)
        dir.create(project)
        user_profile <- file.path(case_root, "user.Rprofile")
        baseline <- file.path(case_root, "profile-libraries.rds")
        marker <- file.path(case_root, "user-profile-ran")
        writeLines(c(
            paste0(".libPaths(c(", r_literal(project), ", .libPaths()))"),
            paste0("saveRDS(.libPaths(), ", r_literal(baseline), ")"),
            paste0("file.create(", r_literal(marker), ")")
        ), user_profile)
        startup_profile <- file.path(case_root, "startup.Rprofile")
        production_profile <- file.path(getwd(), "R", "profile.R")
        writeLines(c(
            "Sys.setenv(R_PROFILE_USER_OLD=Sys.getenv('VSCODE_R_TEST_USER_PROFILE'))",
            paste0(".libPaths(c(Sys.getenv('VSCODE_R_TEST_NORMAL_LIBRARY'), .libPaths()))"),
            "source(Sys.getenv('VSCODE_R_TEST_PROFILE'))"
        ), startup_profile)
        managed_library <- sess_managed_library(managed_root, revision)
        install_library <- switch(
                                  mode,
                                  profile_exact = normal,
                                  profile_prepared = managed_library,
                                  file.path(managed_root,
                                            "fixture-other-platform", "99.99", strrep("a", 40), "library"))
        dir.create(install_library, recursive = TRUE, showWarnings = FALSE)
        if (mode %in% c("profile_decline", "profile_approve")) {
            wrong_sess <- file.path(install_library, "sess")
            dir.create(wrong_sess, recursive = TRUE)
            writeLines(c("Package: sess", "Version: 1.0.0",
                         paste0("Config/vscode-R/source-revision: ", revision)),
                       file.path(wrong_sess, "DESCRIPTION"))
        } else {
            utils::install.packages(pkg, repos = NULL, type = "source", lib = install_library,
                                    quiet = TRUE)
        }
        if (mode %in% c("profile_exact", "profile_prepared")) {
            unlink(consent, recursive = TRUE)
        }
        profile_environment <- c(
                                 R_PROFILE_USER = startup_profile,
                                 VSCODE_R_TEST_USER_PROFILE = user_profile,
                                 VSCODE_R_TEST_NORMAL_LIBRARY = normal,
                                 VSCODE_R_TEST_PROFILE = production_profile,
                                 VSCODE_R_SESS_PKG_PATH = pkg,
                                 VSCODE_R_SESS_SOURCE_HELPER = file.path(getwd(), "R", "sess_source.R"),
                                 VSCODE_R_SESS_ATTACH_HELPER = file.path(getwd(), "R", "attach_sess.R"),
                                 VSCODE_R_SESS_INSTALLER_HELPER = file.path(getwd(), "R", "sess-package-install.R"),
                                 VSCODE_R_SESS_ROOT = managed_root,
                                 VSCODE_R_SESS_CONSENT_DIRECTORY = consent)
        profile_keys <- names(profile_environment)
        previous_environment <- Sys.getenv(profile_keys, unset = NA_character_)
        on.exit({
            Sys.unsetenv(profile_keys)
            if (any(!is.na(previous_environment))) {
                do.call(Sys.setenv, as.list(previous_environment[!is.na(previous_environment)]))
            }
        }, add = TRUE)
        do.call(Sys.setenv, as.list(profile_environment))
    }
    consent_modes <- c("approve", "twice", "mismatch", "profile_decline", "profile_approve")
    if (mode %in% consent_modes) {
        log <- file.path(case_root, "consent-ids")
        identity_log <- file.path(case_root, "runtime-identities")
        status_log <- file.path(case_root, "consent-agent-status")
        count <- if (mode == "twice") 2L else 1L
        approve_modes <- c("approve", "profile_approve")
        answer <- if (mode %in% approve_modes) "approve" else "decline"
        system2(r_binary, shQuote(c(
            "--vanilla", "--slave", paste0("--file=", agent), "--args",
            consent, as.character(count), answer, log, identity_log, status_log
        )), wait = FALSE, stdout = FALSE, stderr = FALSE)
    }
    flags <- if (startup) {
        c("--no-site-file", "--no-environ", "--slave", "--no-save", "--no-restore")
    } else {
        c("--vanilla", "--slave", "--no-save", "--no-restore")
    }
    output <- suppressWarnings(system2(r_binary, shQuote(c(
        flags,
        paste0("--file=", runner), "--args", mode, case_root, pkg, revision, mismatch
    )), stdout = TRUE, stderr = TRUE))
    status <- attr(output, "status")
    if (!is.null(status) && status != 0L) stop(paste(output, collapse = "\n"))
    if (mode %in% consent_modes) {
        status_path <- file.path(case_root, "consent-agent-status")
        deadline <- Sys.time() + 5
        while (!file.exists(status_path) && Sys.time() < deadline) Sys.sleep(0.01)
        if (!file.exists(status_path)) stop(paste("consent agent did not finish:", mode))
        agent_status <- readLines(status_path, warn = FALSE)
        if (!identical(agent_status, "ok")) {
            stop(paste("consent agent failed:", paste(agent_status, collapse = " ")))
        }
        log_path <- file.path(case_root, "consent-ids")
        ids <- readLines(log_path, warn = FALSE)
        expected_count <- if (mode == "twice") 2L else 1L
        stopifnot(length(ids) == expected_count, !anyDuplicated(ids))
        stopifnot(all(grepl("^[A-Za-z0-9_-]{16,64}$", ids)))
        identity_log <- file.path(case_root, "runtime-identities")
        runtime_identity <- readLines(identity_log, warn = FALSE)
        minor <- strsplit(R.version$minor, ".", fixed = TRUE)[[1L]][1L]
        expected_runtime <- paste(R.version$platform,
                                  paste(R.version$major, minor, sep = "."), sep = "|")
        stopifnot(length(runtime_identity) == expected_count)
        stopifnot(all(runtime_identity == expected_runtime))
    }
}

for (mode in c(
    "twice", "mismatch", "exact", "prepared", "timeout", "approve",
    "profile_exact", "profile_prepared", "profile_decline", "profile_approve"
)) run_case(mode)
unlink(root, recursive = TRUE)
cat("manual attach consent bridge tests passed\n")
