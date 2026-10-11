# Base-R integration coverage for manual attach consent; all packages are local fixtures.
source("R/sess_source.R")
root <- tempfile("attach-sess-")
dir.create(root)
on.exit(unlink(root, recursive = TRUE), add = TRUE)
Sys.unsetenv("VSCODE_R_SESS_STARTUP_FILE")

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
    "connect <- function(endpoint=NULL, plot_backend=NULL, ...) TRUE",
    "notify_client <- function(...) NULL", "request_client <- function(...) NULL",
    ".onLoad <- function(libname, pkgname) {",
    "  complete <- Sys.getenv('VSCODE_R_TEST_INSTALL_COMPLETE', '')",
    "  if (nzchar(complete) && !file.exists(complete)) stop('loaded before install completed')",
    "  role <- Sys.getenv('VSCODE_R_TEST_ROLE', '')",
    "  owner_file <- Sys.getenv('VSCODE_R_TEST_LOCK_OWNER', '')",
    "  if (role == 'follower' && nzchar(owner_file) &&",
    "      identical(readLines(owner_file, warn=FALSE)[[1L]], 'owner')) {",
    "    stop('follower loaded while owner held setup lock')",
    "  }",
    "  log <- Sys.getenv('VSCODE_R_TEST_LOAD_LOG', '')",
    "  if (nzchar(log)) cat(role, '\\n', sep='', file=log, append=TRUE)",
    "}"
), file.path(pkg, "R", "api.R"))
writeLines(c("export(connect)", "export(notify_client)", "export(request_client)"),
           file.path(pkg, "NAMESPACE"))

runner <- file.path(root, "run-case.R")
writeLines(c(
    "args <- commandArgs(TRUE)",
    "mode <- args[[1L]]; root <- args[[2L]]; pkg <- args[[3L]]",
    "revision <- args[[4L]]; mismatch <- args[[5L]]",
    "role <- if (length(args) >= 6L) args[[6L]] else ''",
    "result_file <- if (length(args) >= 7L) args[[7L]] else ''",
    "source(file.path(getwd(), 'R', 'sess_source.R'))",
    "source(file.path(getwd(), 'R', 'terminal-startup.R'))",
    "normal <- file.path(root, 'normal library')",
    "dir.create(normal, recursive=TRUE, showWarnings=FALSE)",
    "consent <- file.path(root, 'consent')",
    "dir.create(consent, recursive=TRUE, showWarnings=FALSE)",
    "managed_root <- file.path(root, 'vscode-R')",
    "managed_library <- sess_managed_library(managed_root, revision)",
    "ready_path <- file.path(dirname(managed_library), '.ready')",
    "startup_status <- file.path(root, 'profile.status')",
    "lock_path <- file.path(dirname(managed_library), '.setup-lock')",
    "owner_file <- file.path(lock_path, 'fixture-owner')",
    "owner_ready <- file.path(root, 'owner-lock-ready')",
    "follower_observed <- file.path(root, 'follower-observed-lock')",
    "load_log <- file.path(root, 'load-log')",
    "install_complete <- file.path(root, 'install-complete')",
    "install_helper <- Sys.getenv('VSCODE_R_TEST_INSTALL_HELPER', '')",
    "if (startsWith(mode, 'parallel_')) {",
    "  Sys.setenv(VSCODE_R_TEST_ROLE=role, VSCODE_R_TEST_LOCK_OWNER=owner_file,",
    "             VSCODE_R_TEST_LOAD_LOG=load_log,",
    "             VSCODE_R_TEST_INSTALL_COMPLETE=install_complete)",
    "  dir.create <- function(path, ...) {",
    "    created <- base::dir.create(path, ...)",
    "    if (isTRUE(created) && identical(normalizePath(path, mustWork=FALSE),",
    "                                     normalizePath(lock_path, mustWork=FALSE))) {",
    "      writeLines(role, owner_file)",
    "      if (role == 'owner') file.create(owner_ready)",
    "    }",
    "    created",
    "  }",
    "  Sys.sleep <- function(time) {",
    "    if (role == 'follower' && file.exists(owner_file)) {",
    "      owner <- tryCatch(readLines(owner_file, warn=FALSE, n=1L),",
    "                        error=function(e) character())",
    "      if (identical(owner, 'owner')) file.create(follower_observed)",
    "    }",
    "    base::Sys.sleep(time)",
    "  }",
    "  file.rename <- function(from, to) {",
    "    renamed <- base::file.rename(from, to)",
    "    if (isTRUE(renamed) && grepl('\\\\.request$', to)) {",
    "      cat(to, '\\n', file=Sys.getenv('VSCODE_R_TEST_REQUEST_LOG'), append=TRUE)",
    "    }",
    "    renamed",
    "  }",
    "}",
    "source(file.path(getwd(), 'R', 'attach_sess.R'))",
    "project_library <- file.path(root, 'project library')",
    "Sys.setenv(R_LIBS_USER=file.path(root, 'empty user library'), R_LIBS_SITE=.Library)",
    "profile_mode <- startsWith(mode, 'profile_')",
    "if (!profile_mode) .libPaths(c(normal, .Library))",
    "ordinary <- .libPaths()",
    "same_paths <- function(x, y) identical(normalizePath(x, winslash='/'),",
    "                                     normalizePath(y, winslash='/'))",
    "startup_token <- Sys.getenv('VSCODE_R_SESS_STARTUP_TOKEN', '')",
    "read_startup <- function(expected_state, expected_endpoint='endpoint') {",
    "  lines <- readLines(startup_status, warn=FALSE)",
    "  stopifnot(length(lines) == 6L, lines[[1L]] == 'vscode-r-terminal-startup-v1')",
    "  stopifnot(identical(lines[[2L]], startup_token))",
    "  stopifnot(grepl('^[A-Za-z0-9_-]{16,64}$', lines[[3L]]))",
    "  stopifnot(grepl('^[1-9][0-9]*$', lines[[4L]]),",
    "            identical(lines[[4L]], as.character(Sys.getpid())))",
    "  stopifnot(identical(lines[[5L]], expected_endpoint),",
    "            identical(lines[[6L]], expected_state))",
    "  lines",
    "}",
    "check_user_profile <- function() {",
    "  baseline <- readRDS(file.path(root, 'profile-libraries.rds'))",
    "  if (!same_paths(.libPaths(), baseline)) stop('user profile library paths changed')",
    "  stopifnot(file.exists(file.path(root, 'user-profile-ran'))) ",
    "  stopifnot(any(normalizePath(.libPaths()) == normalizePath(project_library)))",
    "}",
    "attach_sess <- function(endpoint='endpoint', timeout=180, setup_timeout=8) {",
    "  vscode_r_attach_sess(endpoint, pkg, managed_root, consent,",
    "    file.path(getwd(), 'R', 'sess_source.R'),",
    "    if (nzchar(install_helper)) install_helper else",
    "      file.path(getwd(), 'R', 'sess-package-install.R'),",
    "    'standard', timeout_seconds=timeout, setup_timeout_seconds=setup_timeout)",
    "}",
    "publish_result <- function(value) {",
    "  temporary <- tempfile(tmpdir=dirname(result_file))",
    "  on.exit(unlink(temporary))",
    "  writeLines(value, temporary)",
    "  if (!file.rename(temporary, result_file)) stop('could not publish child result')",
    "}",
    "execute_case <- function() {",
    "if (mode %in% c('exact', 'prepared', 'markers')) {",
    "  expected <- if (mode == 'exact') normal else",
    "    sess_managed_library(managed_root, revision)",
    "  dir.create(expected, recursive=TRUE, showWarnings=FALSE)",
    "  utils::install.packages(pkg, repos=NULL, type='source', lib=expected, quiet=TRUE)",
    "  if (mode == 'prepared') writeLines(revision, ready_path)",
    "  if (mode %in% c('exact', 'prepared')) {",
    "    result <- attach_sess(timeout=0)",
    "    stopifnot(identical(result, TRUE), same_paths(.libPaths(), ordinary))",
    "    stopifnot(identical(sess_loaded_source_revision(), revision))",
    "    actual <- getNamespaceInfo(asNamespace('sess'), 'path')",
    "    stopifnot(same_paths(actual, file.path(expected, 'sess')))",
    "    if (mode == 'prepared') stopifnot(identical(readLines(ready_path), revision))",
    "    stopifnot(length(list.files(consent, pattern='\\\\.request$')) == 0L)",
    "    if (mode == 'exact') {",
    "      blocked_file <- file.path(root, 'missing-directory', 'startup')",
    "      context <- vscode_r_startup_register(blocked_file, strrep('c', 32), 'endpoint')",
    "      called <- FALSE",
    "      result <- vscode_r_startup_run(context, function() { called <<- TRUE; TRUE })",
    "      stopifnot(identical(result, FALSE), !called, !file.exists(blocked_file))",
    "      reconnect_file <- file.path(root, 'reconnect.status')",
    "      reconnect_context <- vscode_r_startup_register(",
    "        reconnect_file, strrep('d', 32), 'endpoint-a')",
    "      result <- vscode_r_startup_run(reconnect_context, function() TRUE)",
    "      first <- readLines(reconnect_file, warn=FALSE)",
    "      stopifnot(identical(result, TRUE), length(first) == 6L,",
    "                first[[5L]] == 'endpoint-a', first[[6L]] == 'ready')",
    "      scheduler <- new.env(parent=globalenv())",
    "      scheduler$.sess_env <- new.env(parent=emptyenv())",
    "      scheduler$.sess_env$transport_generation <- 1L",
    "      scheduler$.sess_env$con <- NULL",
    "      scheduler$.sess_env$reconnect <- NULL",
    "      scheduler$.sess_env$pending_responses <- list()",
    "      scheduler$.sess_env$read_buffer <- ''",
    "      connect_count <- 0L; observed <- list(); callbacks <- list()",
    "      schedule <- function(callback, delay) {",
    "        callbacks[[length(callbacks) + 1L]] <<- callback",
    "      }",
    "      sys.source(file.path(getwd(), 'sess', 'R', 'server.R'), scheduler)",
    "      scheduler$.read_discovery <- function(path) list(endpoint='endpoint-b')",
    "      scheduler$.configure_discovery_jgd <- function(discovery, enabled) NULL",
    "      scheduler$runtime_stop <- function() invisible(NULL)",
    "      scheduler$connect <- function(endpoint, ...) {",
    "        connect_count <<- connect_count + 1L",
    "        observed[[connect_count]] <<- readLines(reconnect_file, warn=FALSE)",
    "        if (connect_count == 1L) return(FALSE)",
    "        scheduler$.sess_env$con <- list(endpoint=endpoint)",
    "        TRUE",
    "      }",
    "      settings <- list(path=file.path(root, 'discovery'), endpoint='endpoint-a',",
    "                       options=list(plot_backend='standard'))",
    "      scheduler$.schedule_reconnect(settings, 1L, schedule)",
    "      callbacks[[1L]]()",
    "      failed <- readLines(reconnect_file, warn=FALSE)",
    "      stopifnot(length(observed) == 1L, observed[[1L]][[5L]] == 'endpoint-b',",
    "                observed[[1L]][[6L]] == 'pending')",
    "      stopifnot(failed[[5L]] == 'endpoint-b', failed[[6L]] == 'failed',",
    "                failed[[3L]] != first[[3L]], length(callbacks) == 2L)",
    "      callbacks[[2L]]()",
    "      ready <- readLines(reconnect_file, warn=FALSE)",
    "      stopifnot(length(observed) == 2L, observed[[2L]][[5L]] == 'endpoint-b',",
    "                observed[[2L]][[6L]] == 'pending')",
    "      stopifnot(ready[[5L]] == 'endpoint-b', ready[[6L]] == 'ready',",
    "                ready[[3L]] != failed[[3L]], connect_count == 2L)",
    "    }",
    "  } else if (mode == 'markers') {",
    "    description <- file.path(expected, 'sess', 'DESCRIPTION')",
    "    before <- readLines(description, warn=FALSE)",
    "    result <- attach_sess(timeout=8)",
    "    stopifnot(identical(result, FALSE), !('sess' %in% loadedNamespaces()))",
    "    stopifnot(same_paths(.libPaths(), ordinary), identical(readLines(description), before))",
    "    stopifnot(!file.exists(ready_path))",
    "    writeLines(mismatch, ready_path)",
    "    result <- attach_sess(timeout=8)",
    "    stopifnot(identical(result, FALSE), !('sess' %in% loadedNamespaces()))",
    "    stopifnot(same_paths(.libPaths(), ordinary), identical(readLines(description), before))",
    "    stopifnot(identical(readLines(ready_path), mismatch))",
    "    stopifnot(length(list.files(consent, pattern='\\\\.request$')) == 0L)",
    "  }",
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
    "} else if (mode == 'profile_exact') {",
    "  expected <- normal",
    "  stopifnot('sess' %in% loadedNamespaces())",
    "  stopifnot(identical(sess_loaded_source_revision(), revision))",
    "  stopifnot(same_paths(.libPaths(), ordinary))",
    "  actual <- getNamespaceInfo(asNamespace('sess'), 'path')",
    "  stopifnot(same_paths(actual, file.path(expected, 'sess')))",
    "  check_user_profile()",
    "  stopifnot(length(list.files(consent, pattern='\\\\.request$')) == 0L)",
    "  stopifnot(identical(read_startup('ready')[[2L]], Sys.getenv('VSCODE_R_SESS_STARTUP_TOKEN')))",
    "} else if (mode == 'profile_decline') {",
    "  wrong_library <- file.path(managed_root, 'fixture-other-platform',",
    "                             '99.99', strrep('a', 40), 'library')",
    "  stopifnot(!('sess' %in% loadedNamespaces()))",
    "  stopifnot(same_paths(.libPaths(), ordinary))",
    "  check_user_profile()",
    "  stopifnot(!dir.exists(sess_managed_library(managed_root, revision)))",
    "  stopifnot(!file.exists(ready_path))",
    "  first_startup <- read_startup('failed')",
    "  stopifnot(file.exists(file.path(wrong_library, 'sess', 'DESCRIPTION')))",
    "  stopifnot(length(list.files(consent, pattern='\\\\.request$')) == 0L)",
    "  context <- vscode_r_startup_existing('reload-endpoint')",
    "  stopifnot(!is.null(context), identical(context$endpoint, 'reload-endpoint'))",
    "  stopifnot(is.null(vscode_r_startup_existing(''))) ",
    "  saved_existing <- vscode_r_startup_existing",
    "  saved_run <- vscode_r_startup_run",
    "  rm(vscode_r_startup_existing, vscode_r_startup_run, envir=.GlobalEnv)",
    "  Sys.unsetenv('VSCODE_R_SESS_STARTUP_HELPER')",
    "  result <- attach_sess(timeout=0)",
    "  assign('vscode_r_startup_existing', saved_existing, envir=.GlobalEnv)",
    "  assign('vscode_r_startup_run', saved_run, envir=.GlobalEnv)",
    "  stopifnot(identical(result, FALSE), !('sess' %in% loadedNamespaces()))",
    "  stopifnot(identical(read_startup('failed')[[3L]], first_startup[[3L]]))",
    "  stopifnot(!length(list.files(consent, pattern='\\\\.request$'))) ",
    "  Sys.unsetenv(c('VSCODE_R_SESS_STARTUP_FILE', 'VSCODE_R_SESS_STARTUP_TOKEN',",
    "                 'VSCODE_R_SESS_STARTUP_ENDPOINT'))",
    "  result <- attach_sess(endpoint='reload-endpoint', timeout=10)",
    "  second_startup <- read_startup('ready', 'reload-endpoint')",
    "  stopifnot(identical(result, TRUE), first_startup[[3L]] != second_startup[[3L]])",
    "  vscode_r_startup_finish(context, first_startup[[3L]], 'failed')",
    "  stopifnot(identical(read_startup('ready', 'reload-endpoint')[[3L]], second_startup[[3L]]))",
    "  stopifnot(identical(sess_loaded_source_revision(), revision))",
    "  actual <- getNamespaceInfo(asNamespace('sess'), 'path')",
    "  stopifnot(same_paths(actual, file.path(sess_managed_library(managed_root, revision), 'sess')))",
    "  stopifnot(identical(readLines(ready_path), revision))",
    "} else if (mode == 'profile_approve') {",
    "  wrong_library <- file.path(managed_root, 'fixture-other-platform',",
    "                             '99.99', strrep('a', 40), 'library')",
    "  library <- sess_managed_library(managed_root, revision)",
    "  stopifnot('sess' %in% loadedNamespaces())",
    "  stopifnot(identical(sess_loaded_source_revision(), revision))",
    "  stopifnot(same_paths(.libPaths(), ordinary))",
    "  check_user_profile()",
    "  actual <- getNamespaceInfo(asNamespace('sess'), 'path')",
    "  stopifnot(same_paths(actual, file.path(library, 'sess')))",
    "  stopifnot(file.exists(file.path(library, 'sess', 'DESCRIPTION')))",
    "  stopifnot(identical(readLines(ready_path), revision))",
    "  stopifnot(identical(read_startup('ready')[[2L]], Sys.getenv('VSCODE_R_SESS_STARTUP_TOKEN')))",
    "  stopifnot(file.exists(file.path(wrong_library, 'sess', 'DESCRIPTION')))",
    "} else if (mode %in% c('parallel_approve', 'parallel_decline', 'parallel_third',",
    "                       'parallel_failure', 'parallel_retry')) {",
    "  timeout <- 10",
    "  if (mode == 'parallel_approve') {",
    "    result <- attach_sess(timeout=timeout, setup_timeout=20)",
    "    stopifnot(identical(result, TRUE), 'sess' %in% loadedNamespaces())",
    "    stopifnot(identical(sess_loaded_source_revision(), revision))",
    "    actual <- getNamespaceInfo(asNamespace('sess'), 'path')",
    "    stopifnot(same_paths(actual, file.path(managed_library, 'sess')))",
    "    stopifnot(same_paths(.libPaths(), ordinary))",
    "  } else if (mode == 'parallel_failure') {",
    "    result <- tryCatch(attach_sess(timeout=10), error=identity)",
    "    stopifnot(inherits(result, 'error'), !('sess' %in% loadedNamespaces()))",
    "    stopifnot(file.exists(file.path(managed_library, 'sess', 'DESCRIPTION')))",
    "    stopifnot(!file.exists(ready_path), !dir.exists(lock_path))",
    "    stopifnot(same_paths(.libPaths(), ordinary))",
    "  } else {",
    "    result <- attach_sess(timeout=timeout, setup_timeout=20)",
    "    stopifnot(identical(result, FALSE), !('sess' %in% loadedNamespaces()))",
    "    if (mode == 'parallel_retry') stopifnot(file.exists(file.path(managed_library, 'sess', 'DESCRIPTION')))",
    "    else stopifnot(!file.exists(file.path(managed_library, 'sess', 'DESCRIPTION'))) ",
    "    stopifnot(!file.exists(ready_path))",
    "    stopifnot(same_paths(.libPaths(), ordinary))",
    "  }",
    "} else if (mode == 'lock_timeout') {",
    "  lock <- file.path(dirname(managed_library), '.setup-lock')",
    "  lock_marker <- file.path(lock, 'foreign-owner')",
    "  stopifnot(dir.exists(lock), file.exists(lock_marker))",
    "  result <- tryCatch(attach_sess(timeout=0, setup_timeout=0.5), error=identity)",
    "  stopifnot(inherits(result, 'error'), grepl('Timed out waiting for another sess setup',",
    "                                                conditionMessage(result), fixed=TRUE))",
    "  stopifnot(dir.exists(lock), file.exists(lock_marker))",
    "  stopifnot(length(list.files(consent, pattern='\\\\.request$')) == 0L)",
    "  stopifnot(!file.exists(ready_path))",
    "} else stop('unknown case')",
    "cat('manual attach case passed:', mode, '\\n')",
    "}",
    "if (nzchar(result_file)) {",
    "  tryCatch({ execute_case(); publish_result('ok') },",
    "    error=function(e) publish_result(paste0('error: ', conditionMessage(e))))",
    "} else execute_case()"
), runner)

agent <- file.path(root, "consent-agent.R")
writeLines(c(
    "args <- commandArgs(TRUE)",
    "directory <- args[[1L]]; count <- as.integer(args[[2L]])",
    "answers <- strsplit(args[[3L]], ',', fixed=TRUE)[[1L]]",
    "log <- args[[4L]]; identity_log <- args[[5L]]",
    "status_log <- args[[6L]]; wait_marker <- args[[7L]]",
    "tryCatch({",
    "startup_helper <- Sys.getenv('VSCODE_R_SESS_STARTUP_HELPER', '')",
    "if (nzchar(startup_helper)) {",
    "  source(startup_helper)",
    "  inherited <- vscode_r_startup_existing('endpoint')",
    "  if (!is.null(inherited)) stop('child reused the parent startup context')",
    "}",
    "ids <- character(); identities <- character(); deadline <- Sys.time() + 30",
    "while (length(ids) < count && Sys.time() < deadline) {",
    "  requests <- list.files(directory, pattern='\\\\.request$', full.names=TRUE)",
    "  for (request in requests) {",
    "    lines <- readLines(request, warn=FALSE)",
    "    if (length(lines) != 5L || lines[[1L]] != 'vscode-r-sess-consent-v1') stop('bad request')",
    "    id <- lines[[2L]]; if (id %in% ids) next",
    "    if (nzchar(wait_marker) && !file.exists(wait_marker)) next",
    "    ids <- c(ids, id); temporary <- tempfile(tmpdir=directory)",
    "    identities <- c(identities, lines[[4L]])",
    "    answer <- answers[[min(length(ids), length(answers))]]",
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
read_child_logs <- function(paths) {
    read_log <- function(path) {
        tryCatch(readLines(path, warn = FALSE), error = function(e) paste("could not read", path))
    }
    c(read_log(paths$stdout), read_log(paths$stderr))
}
run_case <- function(mode) {
    case_root <- file.path(root, mode)
    dir.create(case_root)
    startup_status <- file.path(case_root, "profile.status")
    consent <- file.path(case_root, "consent")
    dir.create(consent)
    profile_modes <- c("profile_exact", "profile_decline", "profile_approve")
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
        startup_status <- file.path(case_root, "profile.status")
        production_profile <- file.path(getwd(), "R", "profile.R")
        writeLines(c(
            "Sys.setenv(R_PROFILE_USER_OLD=Sys.getenv('VSCODE_R_TEST_USER_PROFILE'))",
            paste0(".libPaths(c(Sys.getenv('VSCODE_R_TEST_NORMAL_LIBRARY'), .libPaths()))"),
            "source(Sys.getenv('VSCODE_R_TEST_PROFILE'))"
        ), startup_profile)
        managed_library <- sess_managed_library(managed_root, revision)
        install_library <- if (mode == "profile_exact") {
            normal
        } else {
            file.path(managed_root, "fixture-other-platform", "99.99",
                      strrep("a", 40), "library")
        }
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
        if (mode == "profile_exact") {
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
                                 VSCODE_R_SESS_CONSENT_DIRECTORY = consent,
                                 VSCODE_R_SESS_STARTUP_FILE = startup_status,
                                 VSCODE_R_SESS_STARTUP_TOKEN = paste0(strrep("c", 32L)),
                                 VSCODE_R_SESS_STARTUP_ENDPOINT = "endpoint",
                                 VSCODE_R_SESS_STARTUP_HELPER = file.path(getwd(), "R", "terminal-startup.R"))
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
    consent_modes <- c("markers", "mismatch", "profile_decline", "profile_approve")
    if (mode %in% consent_modes) {
        log <- file.path(case_root, "consent-ids")
        identity_log <- file.path(case_root, "runtime-identities")
        status_log <- file.path(case_root, "consent-agent-status")
        count <- if (mode %in% c("markers", "profile_decline")) 2L else 1L
        answer <- switch(mode, profile_approve = "approve", profile_decline = "decline,approve",
                         "decline")
        release_marker <- if (mode %in% c("profile_decline", "profile_approve")) {
            file.path(case_root, "release-profile-consent")
        } else {
            ""
        }
        system2(r_binary, shQuote(c(
            "--vanilla", "--slave", paste0("--file=", agent), "--args",
            consent, as.character(count), answer, log, identity_log, status_log, release_marker
        )), wait = FALSE, stdout = FALSE, stderr = FALSE)
    }
    flags <- if (startup) {
        c("--no-site-file", "--no-environ", "--slave", "--no-save", "--no-restore")
    } else {
        c("--vanilla", "--slave", "--no-save", "--no-restore")
    }
    if (mode %in% c("profile_decline", "profile_approve")) {
        result_file <- file.path(case_root, "startup-runner-result")
        stdout_path <- file.path(case_root, "startup-runner-stdout")
        stderr_path <- file.path(case_root, "startup-runner-stderr")
        system2(
            r_binary,
            shQuote(c(
                flags,
                paste0("--file=", runner), "--args", mode, case_root, pkg, revision, mismatch,
                "", result_file
            )),
            wait = FALSE,
            stdout = stdout_path,
            stderr = stderr_path
        )
        deadline <- Sys.time() + 10
        requests <- character()
        while (!length(requests) && Sys.time() < deadline) {
            requests <- list.files(consent, pattern = "\\.request$", full.names = TRUE)
            if (!length(requests)) Sys.sleep(0.01)
        }
        if (!length(requests)) stop("profile startup did not publish a consent request")
        startup_record <- readLines(startup_status, warn = FALSE)
        stopifnot(length(startup_record) == 6L,
                  startup_record[[1L]] == "vscode-r-terminal-startup-v1",
                  startup_record[[2L]] == Sys.getenv("VSCODE_R_SESS_STARTUP_TOKEN"),
                  grepl("^[A-Za-z0-9_-]{16,64}$", startup_record[[3L]]),
                  grepl("^[1-9][0-9]*$", startup_record[[4L]]),
                  startup_record[[5L]] == "endpoint",
                  startup_record[[6L]] == "pending")
        file.create(release_marker)
        deadline <- Sys.time() + 30
        while (!file.exists(result_file) && Sys.time() < deadline) Sys.sleep(0.01)
        if (!file.exists(result_file)) {
            child_output <- read_child_logs(list(stdout = stdout_path, stderr = stderr_path))
            stop(paste(mode, "startup child timed out; output:", paste(child_output, collapse = "\n")))
        }
        child_result <- readLines(result_file, warn = FALSE)
        if (!identical(child_result, "ok")) {
            child_output <- read_child_logs(list(stdout = stdout_path, stderr = stderr_path))
            stop(paste(mode, "startup child failed:", paste(child_result, collapse = " "),
                       "output:", paste(child_output, collapse = "\n")))
        }
    } else {
        output <- suppressWarnings(
            system2(
                r_binary,
                shQuote(c(
                    flags,
                    paste0("--file=", runner), "--args", mode, case_root, pkg, revision, mismatch,
                    "", ""
                )),
                stdout = TRUE,
                stderr = TRUE
            )
        )
        status <- attr(output, "status")
        if (!is.null(status) && status != 0L) stop(paste(output, collapse = "\n"))
    }
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
        expected_count <- if (mode %in% c("markers", "profile_decline")) 2L else 1L
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
    "mismatch", "exact", "prepared", "markers", "profile_exact", "profile_decline", "profile_approve"
)) run_case(mode)

wait_for_file <- function(path, seconds, description) {
    deadline <- Sys.time() + seconds
    while (!file.exists(path) && Sys.time() < deadline) Sys.sleep(0.01)
    if (!file.exists(path)) stop(paste("Timed out waiting for", description))
}

wait_for_request <- function(directory, seconds) {
    deadline <- Sys.time() + seconds
    requests <- character()
    while (!length(requests) && Sys.time() < deadline) {
        requests <- list.files(directory, pattern = "\\.request$", full.names = TRUE)
        if (!length(requests)) Sys.sleep(0.01)
    }
    if (!length(requests)) stop("Timed out waiting for owner consent request")
    requests[[1L]]
}

start_consent_agent <- function(case_root, answer, wait_marker = "", label = "consent") {
    consent <- file.path(case_root, "consent")
    log <- file.path(case_root, paste0(label, "-ids"))
    identity_log <- file.path(case_root, paste0(label, "-identities"))
    status <- file.path(case_root, paste0(label, "-status"))
    stdout <- file.path(case_root, paste0(label, "-stdout"))
    stderr <- file.path(case_root, paste0(label, "-stderr"))
    system2(
        r_binary,
        shQuote(c(
            "--vanilla", "--slave", paste0("--file=", agent), "--args",
            consent, "1", answer, log, identity_log, status, wait_marker
        )),
        wait = FALSE,
        stdout = stdout,
        stderr = stderr
    )
    list(log = log, identity_log = identity_log, status = status,
         stdout = stdout, stderr = stderr)
}

wait_for_agent <- function(paths) {
    wait_for_file(paths$status, 10, "consent-agent completion")
    result <- readLines(paths$status, warn = FALSE)
    if (!identical(result, "ok")) {
        stop(paste("Consent agent failed:", paste(result, collapse = " ")))
    }
    ids <- readLines(paths$log, warn = FALSE)
    identities <- readLines(paths$identity_log, warn = FALSE)
    stopifnot(length(ids) == 1L, grepl("^[A-Za-z0-9_-]{16,64}$", ids))
    minor <- strsplit(R.version$minor, ".", fixed = TRUE)[[1L]][1L]
    expected_runtime <- paste(
        R.version$platform,
        paste(R.version$major, minor, sep = "."),
        sep = "|"
    )
    stopifnot(identical(identities, expected_runtime))
    ids
}

start_parallel_child <- function(case_root, mode, role, result_file, install_helper = "") {
    environment_names <- c("VSCODE_R_TEST_INSTALL_HELPER", "VSCODE_R_TEST_REQUEST_LOG")
    previous <- Sys.getenv(environment_names, unset = NA_character_)
    do.call(
        Sys.setenv,
        as.list(c(
            VSCODE_R_TEST_INSTALL_HELPER = install_helper,
            VSCODE_R_TEST_REQUEST_LOG = file.path(case_root, "published-requests")
        ))
    )
    on.exit({
        Sys.unsetenv(environment_names)
        if (any(!is.na(previous))) do.call(Sys.setenv, as.list(previous[!is.na(previous)]))
    })
    stdout <- file.path(case_root, paste0(role, "-stdout"))
    stderr <- file.path(case_root, paste0(role, "-stderr"))
    system2(
        r_binary,
        shQuote(c(
            "--vanilla", "--slave", paste0("--file=", runner), "--args",
            mode, case_root, pkg, revision, mismatch, role, result_file
        )),
        wait = FALSE,
        stdout = stdout,
        stderr = stderr
    )
    list(result = result_file, stdout = stdout, stderr = stderr)
}

wait_for_child <- function(paths, description) {
    deadline <- Sys.time() + 30
    while (!file.exists(paths$result) && Sys.time() < deadline) Sys.sleep(0.01)
    child_output <- read_child_logs(paths)
    if (!file.exists(paths$result)) {
        stop(paste(description, "timed out; child output:", paste(child_output, collapse = "\n")))
    }
    result <- readLines(paths$result, warn = FALSE)
    if (!identical(result, "ok")) {
        stop(paste(description, "failed:", paste(result, collapse = " "),
                   "child output:", paste(child_output, collapse = "\n")))
    }
    invisible(TRUE)
}

run_parallel_setup <- function(approve) {
    mode <- if (approve) "parallel_approve" else "parallel_decline"
    case_root <- file.path(root, mode)
    dir.create(case_root)
    consent <- file.path(case_root, "consent")
    dir.create(consent)
    managed_root <- file.path(case_root, "vscode-R")
    managed_library <- sess_managed_library(managed_root, revision)
    lock_path <- file.path(dirname(managed_library), ".setup-lock")
    ready_path <- file.path(dirname(managed_library), ".ready")
    owner_ready <- file.path(case_root, "owner-lock-ready")
    follower_observed <- file.path(case_root, "follower-observed-lock")
    install_complete <- file.path(case_root, "install-complete")
    description_visible <- file.path(case_root, "install-description-visible")
    install_release <- file.path(case_root, "allow-install-complete")
    install_log <- file.path(case_root, "install-invocations")
    load_log <- file.path(case_root, "load-log")
    install_helper <- file.path(case_root, "blocking-installer.R")
    writeLines(c(
        "sess_install <- function(pkg_path, library, repo) {",
        paste0("  cat('install\\n', file=", r_literal(install_log), ", append=TRUE)"),
        "  test_vars <- c('VSCODE_R_TEST_ROLE', 'VSCODE_R_TEST_LOCK_OWNER',",
        "                 'VSCODE_R_TEST_LOAD_LOG', 'VSCODE_R_TEST_INSTALL_COMPLETE')",
        "  previous <- Sys.getenv(test_vars, unset=NA_character_)",
        "  Sys.unsetenv(test_vars)",
        "  on.exit({",
        "    Sys.unsetenv(test_vars)",
        "    if (any(!is.na(previous))) do.call(Sys.setenv, as.list(previous[!is.na(previous)]))",
        "  }, add=TRUE)",
        "  utils::install.packages(pkg_path, repos=NULL, type='source', lib=library, quiet=TRUE)",
        paste0("  if (!file.exists(file.path(library, 'sess', 'DESCRIPTION'))) stop('install failed')"),
        paste0("  file.create(", r_literal(description_visible), ")"),
        paste0("  deadline <- Sys.time() + 20; release <- ", r_literal(install_release)),
        "  while (!file.exists(release) && Sys.time() < deadline) Sys.sleep(0.01)",
        "  if (!file.exists(release)) stop('installer fixture release timed out')",
        paste0("  file.create(", r_literal(install_complete), ")"),
        "}"
    ), install_helper)

    agent_paths <- start_consent_agent(
        case_root,
        if (approve) "approve" else "decline",
        follower_observed
    )
    owner_result <- file.path(case_root, "owner-result")
    follower_result <- file.path(case_root, "follower-result")
    owner <- start_parallel_child(case_root, mode, "owner", owner_result, install_helper)
    wait_for_file(owner_ready, 10, "owner setup lock")
    wait_for_request(consent, 10)
    follower <- start_parallel_child(case_root, mode, "follower", follower_result)
    wait_for_file(follower_observed, 10, "follower observation of the held setup lock")

    if (approve) {
        wait_for_file(description_visible, 10, "installed package metadata while owner holds lock")
        stopifnot(dir.exists(lock_path), file.exists(file.path(managed_library, "sess", "DESCRIPTION")))
        stopifnot(!file.exists(load_log), !file.exists(ready_path))
        file.create(install_release)
        wait_for_file(install_complete, 10, "installer verification completion")
    }
    wait_for_child(owner, paste(mode, "role=owner"))
    wait_for_child(follower, paste(mode, "role=follower"))
    request_ids <- wait_for_agent(agent_paths)
    published_requests <- readLines(file.path(case_root, "published-requests"), warn = FALSE)
    stopifnot(length(published_requests) == 1L)
    stopifnot(length(list.files(consent, pattern = "\\.(request|response)$")) == 0L)
    stopifnot(!dir.exists(lock_path))
    if (approve) {
        stopifnot(length(readLines(install_log, warn = FALSE)) == 1L)
        stopifnot(file.exists(install_complete), file.exists(load_log))
        stopifnot(identical(readLines(ready_path, warn = FALSE), revision))
        loads <- readLines(load_log, warn = FALSE)
        if (!identical(sort(loads), c("follower", "owner"))) {
            stop(paste("unexpected package load sequence:", paste(loads, collapse = ", ")))
        }
    } else {
        stopifnot(!file.exists(install_log), !dir.exists(managed_library))
        stopifnot(!file.exists(load_log), !file.exists(ready_path))

        third_agent <- start_consent_agent(case_root, "decline", label = "third-consent")
        third_result <- file.path(case_root, "third-result")
        third <- start_parallel_child(case_root, "parallel_third", "third", third_result)
        wait_for_child(third, "parallel_third role=third after decline")
        third_id <- wait_for_agent(third_agent)
        stopifnot(!identical(third_id, request_ids))
        published_requests <- readLines(file.path(case_root, "published-requests"), warn = FALSE)
        stopifnot(length(published_requests) == 2L)
        stopifnot(length(list.files(consent, pattern = "\\.(request|response)$")) == 0L)
        stopifnot(!dir.exists(lock_path), !dir.exists(managed_library))
        stopifnot(!file.exists(install_log), !file.exists(load_log), !file.exists(ready_path))
    }
}

run_parallel_setup(TRUE)
run_parallel_setup(FALSE)

run_failed_install <- function() {
    case_root <- file.path(root, "parallel-failed-install")
    dir.create(case_root)
    dir.create(file.path(case_root, "consent"))
    managed_library <- sess_managed_library(file.path(case_root, "vscode-R"), revision)
    lock_path <- file.path(dirname(managed_library), ".setup-lock")
    ready_path <- file.path(dirname(managed_library), ".ready")
    request_log <- file.path(case_root, "published-requests")
    failure_helper <- file.path(case_root, "failing-installer.R")
    dir.create(managed_library, recursive = TRUE)
    utils::install.packages(pkg, repos = NULL, type = "source", lib = managed_library, quiet = TRUE)
    existing_description <- file.path(managed_library, "sess", "DESCRIPTION")
    description <- read.dcf(existing_description)
    description[1L, "Config/vscode-R/source-revision"] <- mismatch
    write.dcf(description, existing_description)
    writeLines(revision, ready_path)
    writeLines(c(
        "sess_install <- function(pkg_path, library, repo) {",
        "  test_vars <- c('VSCODE_R_TEST_ROLE', 'VSCODE_R_TEST_LOCK_OWNER',",
        "                 'VSCODE_R_TEST_LOAD_LOG', 'VSCODE_R_TEST_INSTALL_COMPLETE')",
        "  previous <- Sys.getenv(test_vars, unset=NA_character_)",
        "  Sys.unsetenv(test_vars)",
        "  on.exit({",
        "    Sys.unsetenv(test_vars)",
        "    if (any(!is.na(previous))) do.call(Sys.setenv, as.list(previous[!is.na(previous)]))",
        "  }, add=TRUE)",
        "  utils::install.packages(pkg_path, repos=NULL, type='source', lib=library, quiet=TRUE)",
        "  if (!file.exists(file.path(library, 'sess', 'DESCRIPTION'))) stop('install failed')",
        "  stop('injected verification failure')",
        "}"
    ), failure_helper)

    first_agent <- start_consent_agent(case_root, "approve", label = "failure-consent")
    first_result <- file.path(case_root, "failure-result")
    first <- start_parallel_child(
        case_root,
        "parallel_failure",
        "failure-owner",
        first_result,
        failure_helper
    )
    wait_for_child(first, "parallel_failure role=failure-owner")
    first_id <- wait_for_agent(first_agent)
    stopifnot(file.exists(file.path(managed_library, "sess", "DESCRIPTION")))
    stopifnot(identical(sess_source_revision(file.path(managed_library, "sess", "DESCRIPTION")), revision))
    stopifnot(!file.exists(ready_path), !dir.exists(lock_path))
    stopifnot(length(readLines(request_log, warn = FALSE)) == 1L)

    retry_agent <- start_consent_agent(case_root, "decline", label = "retry-consent")
    retry_result <- file.path(case_root, "retry-result")
    retry <- start_parallel_child(
        case_root,
        "parallel_retry",
        "retry",
        retry_result
    )
    wait_for_child(retry, "parallel_retry role=retry after failed setup")
    retry_id <- wait_for_agent(retry_agent)
    stopifnot(!identical(first_id, retry_id))
    stopifnot(length(readLines(request_log, warn = FALSE)) == 2L)
    stopifnot(file.exists(file.path(managed_library, "sess", "DESCRIPTION")))
    stopifnot(!file.exists(ready_path), !dir.exists(lock_path))
    stopifnot(!file.exists(file.path(case_root, "load-log")))
}

run_failed_install()

timeout_root <- file.path(root, "foreign-lock-timeout")
dir.create(timeout_root)
timeout_lock <- file.path(
    dirname(sess_managed_library(file.path(timeout_root, "vscode-R"), revision)),
    ".setup-lock"
)
dir.create(timeout_lock, recursive = TRUE)
foreign_marker <- file.path(timeout_lock, "foreign-owner")
writeLines("preserve", foreign_marker)
timeout_result <- file.path(timeout_root, "result")
timeout_output <- suppressWarnings(
    system2(
        r_binary,
        shQuote(c(
            "--vanilla", "--slave", paste0("--file=", runner), "--args",
            "lock_timeout", timeout_root, pkg, revision, mismatch, "timeout", timeout_result
        )),
        stdout = TRUE,
        stderr = TRUE
    )
)
if (!is.null(attr(timeout_output, "status")) && attr(timeout_output, "status") != 0L) {
    stop(paste(timeout_output, collapse = "\n"))
}
stopifnot(identical(readLines(timeout_result, warn = FALSE), "ok"))
stopifnot(dir.exists(timeout_lock), identical(readLines(foreign_marker, warn = FALSE), "preserve"))
stopifnot(!file.exists(file.path(dirname(timeout_lock), ".ready")))
unlink(root, recursive = TRUE)
cat("manual attach consent bridge tests passed\n")
