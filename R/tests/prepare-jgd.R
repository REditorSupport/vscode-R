# Base-R integration coverage for optional jgd preparation during attach.
local({
    root <- tempfile("prepare-jgd-")
    dir.create(root)
    root <- normalizePath(root, winslash = "/", mustWork = TRUE)
    r_literal <- function(value) paste0("\"", gsub("\\\"", "\\\\\\\"", value), "\"")
    on.exit(unlink(root, recursive = TRUE), add = TRUE)

    source_package <- function(version) {
        package <- file.path(root, paste0("jgd-", version))
        dir.create(file.path(package, "R"), recursive = TRUE)
        writeLines(c(
            "Package: jgd", paste0("Version: ", version), "Title: jgd fixture",
            "Description: Local jgd fixture.", "License: MIT", "Author: Test Author",
            "Maintainer: Test Author <test@example.com>", "Encoding: UTF-8"
        ), file.path(package, "DESCRIPTION"))
        writeLines(c(
            "fixture_device <- function() 'jgd'",
            "jgd <- function() {",
            "  path <- Sys.getenv('JGD_TEST_DEVICE_LOG', '')",
            "  if (nzchar(path)) writeLines('jgd', path)",
            "  invisible(NULL)",
            "}"
        ), file.path(package, "R", "api.R"))
        writeLines(c("export(fixture_device)", "export(jgd)"), file.path(package, "NAMESPACE"))
        previous <- setwd(root)
        on.exit(setwd(previous), add = TRUE)
        output <- system2(file.path(R.home("bin"), "R"),
                          c("CMD", "build", "--no-build-vignettes", shQuote(basename(package))),
                          stdout = TRUE, stderr = TRUE)
        status <- attr(output, "status")
        if (!is.null(status) && status != 0L) stop(paste(output, collapse = "\n"))
        archive <- file.path(root, paste0("jgd_", version, ".tar.gz"))
        stopifnot(file.exists(archive))
        contrib <- file.path(root, "repo", "src", "contrib")
        dir.create(contrib, recursive = TRUE, showWarnings = FALSE)
        file.copy(archive, contrib)
        tools::write_PACKAGES(contrib, type = "source")
        package
    }

    package <- source_package("0.1.0")
    source_package("0.0.1")
    repo <- paste0("file:///", sub("^/", "", normalizePath(file.path(root, "repo"), winslash = "/")))
    runner <- file.path(root, "run.R")
    writeLines(c(
        "args <- commandArgs(TRUE); mode <- args[[1L]]; root <- args[[2L]]; repo <- args[[3L]];",
        "result <- args[[4L]];",
        "source(file.path(getwd(), 'R', 'tool-library.R'));",
        "source(file.path(getwd(), 'R', 'tool-consent.R'));",
        "source(file.path(getwd(), 'R', 'prepare-jgd.R'));",
        "source(file.path(getwd(), 'R', 'attach_sess.R'));",
        "options(repos=c(CRAN=repo), pkgType='source');",
        "consent <- file.path(root, 'consent'); dir.create(consent, showWarnings=FALSE);",
        "Sys.setenv(JGD_SOCKET='fixture-socket');",
        "connect_seen <- new.env();",
        "device_log <- file.path(root, paste0(mode, '-device-log'));",
        "Sys.setenv(JGD_TEST_DEVICE_LOG=device_log);",
        "vscode_r_prepare_sess <- function(...) { ns <- new.env(); ns$connect <- function(...) {",
        "  connect_seen$socket <- Sys.getenv('JGD_SOCKET', unset='');",
        "  connect_seen$loaded <- requireNamespace('jgd', quietly=TRUE);",
        "  hooks <- new.env(parent=globalenv());",
        "  sys.source(file.path(getwd(), 'sess', 'R', 'hooks.R'), hooks);",
        "  has_jgd <- nzchar(connect_seen$socket) && connect_seen$loaded;",
        "  connect_seen$device <- hooks$.select_plot_backend('jgd', FALSE, has_jgd);",
        "  if (connect_seen$device == 'jgd') jgd::jgd(); TRUE }; ns };",
        "if (mode == 'old') {",
        "  old <- file.path(root, 'old-library'); dir.create(old);",
        "  utils::install.packages(file.path(root, 'jgd-0.0.1'), repos=NULL, type='source', lib=old, quiet=TRUE);",
        "  .libPaths(c(old, .Library)); loadNamespace('jgd', lib.loc=old);",
        "}",
        "if (mode == 'offline') options(repos=c(CRAN=file.path(root, 'missing-repo')));",
        "tool_library_helper <- if (mode == 'parallel') file.path(root, 'instrumented-tool-library.R') else",
        "  file.path(getwd(), 'R', 'tool-library.R');",
        "timeout_before <- getOption('timeout'); libraries_before <- .libPaths();",
        "answer <- vscode_r_attach_sess('endpoint', 'unused', file.path(root, 'tools'), consent,",
        "  'unused', 'unused', 'jgd', timeout_seconds=0, tool_root=file.path(root, 'tools'),",
        "  tool_consent_directory=consent, tool_library_helper=tool_library_helper,",
        "  tool_consent_helper=file.path(getwd(), 'R', 'tool-consent.R'),",
        "  jgd_helper=file.path(getwd(), 'R', 'prepare-jgd.R'));",
        "stopifnot(isTRUE(answer), identical(Sys.getenv('JGD_SOCKET'), 'fixture-socket'));",
        "stopifnot(identical(getOption('timeout'), timeout_before), identical(.libPaths(), libraries_before));",
        "writeLines(c(connect_seen$socket, as.character(connect_seen$loaded), connect_seen$device), result);"
    ), runner)

    r_binary <- file.path(R.home("bin"), "R")
    run_child <- function(mode, result) {
        child_args <- c("--vanilla", "--slave", paste0("--file=", runner), "--args",
                        mode, root, repo, result)
        output <- system2(r_binary, shQuote(child_args),
                          stdout = TRUE, stderr = TRUE)
        status <- attr(output, "status")
        if (!is.null(status) && status != 0L) stop(paste(output, collapse = "\n"))
        readLines(result, warn = FALSE)
    }

    wait_requests <- function(directory, count) {
        deadline <- Sys.time() + 15
        repeat {
            paths <- list.files(directory, pattern = "\\.request$", full.names = TRUE)
            if (length(paths) >= count) return(paths)
            if (Sys.time() >= deadline) {
                log_paths <- list.files(root, pattern = "(out|err)$", recursive = TRUE,
                                        full.names = TRUE)
                logs <- unlist(lapply(log_paths, function(path) {
                    c(path, readLines(path, warn = FALSE))
                }))
                stop("Timed out waiting for jgd consent request in ", directory, ": ",
                     paste(logs, collapse = "\n"))
            }
            Sys.sleep(0.01)
        }
    }

    answer_requests <- function(paths, answer) {
        for (path in paths) {
            id <- sub("\\.request$", "", basename(path))
            temporary <- file.path(dirname(path), paste0(id, ".response.tmp"))
            writeLines(answer, temporary, useBytes = TRUE)
            stopifnot(file.rename(temporary, file.path(dirname(path), paste0(id, ".response"))))
        }
    }

    approved_root <- file.path(root, "approved")
    dir.create(approved_root)
    approved_result <- file.path(root, "approved-result")
    approved_args <- c("--vanilla", "--slave", paste0("--file=", runner), "--args",
                       "approved", approved_root, repo, approved_result)
    approved_process <- system2(r_binary, shQuote(approved_args), wait = FALSE,
                                stdout = file.path(root, "approved-out"),
                                stderr = file.path(root, "approved-err"))
    request <- wait_requests(file.path(approved_root, "consent"), 1L)
    answer_requests(request, "approve")
    deadline <- Sys.time() + 30
    while (!file.exists(approved_result) && Sys.time() < deadline) Sys.sleep(0.01)
    if (!file.exists(approved_result)) {
        logs <- unlist(lapply(c("approved-out", "approved-err"), function(name) {
            path <- file.path(root, name)
            if (file.exists(path)) readLines(path, warn = FALSE) else character()
        }))
        stop("Approved jgd attach did not finish: ", paste(logs, collapse = "\n"))
    }
    stopifnot(identical(readLines(approved_result), c("fixture-socket", "TRUE", "jgd")))
    stopifnot(identical(readLines(file.path(approved_root, "approved-device-log")), "jgd"))

    declined_root <- file.path(root, "declined")
    dir.create(declined_root)
    declined_result <- file.path(root, "declined-result")
    declined_args <- c("--vanilla", "--slave", paste0("--file=", runner), "--args",
                       "declined", declined_root, repo, declined_result)
    declined_process <- system2(r_binary, shQuote(declined_args), wait = FALSE,
                                stdout = file.path(root, "declined-out"),
                                stderr = file.path(root, "declined-err"))
    request <- wait_requests(file.path(declined_root, "consent"), 1L)
    answer_requests(request, "decline")
    deadline <- Sys.time() + 30
    while (!file.exists(declined_result) && Sys.time() < deadline) Sys.sleep(0.01)
    if (!file.exists(declined_result)) stop("Declined jgd attach did not finish.")
    stopifnot(identical(readLines(declined_result), c("", "FALSE", "standard")))

    for (mode in c("old", "offline")) {
        result <- file.path(root, paste0(mode, "-result"))
        observed <- run_child(mode, result)
        stopifnot(identical(observed, c("", if (mode == "old") "TRUE" else "FALSE", "standard")))
        stopifnot(length(list.files(file.path(root, mode, "consent"), pattern = "\\.request$")) == 0L)
    }

    parallel_root <- file.path(root, "parallel")
    dir.create(parallel_root)
    base_helper <- readLines(file.path(getwd(), "R", "tool-library.R"), warn = FALSE)
    instrumented_helper <- file.path(parallel_root, "instrumented-tool-library.R")
    writeLines(c(base_helper,
                 ".tool_verify_child_base <- .tool_verify_child",
                 paste0(".tool_verify_child <- function(...) { cat('verify\\n', file=",
                        r_literal(file.path(parallel_root, "verify-log")), ", append=TRUE);",
                        " .tool_verify_child_base(...) }")), instrumented_helper)
    parallel_consent <- file.path(parallel_root, "consent")
    dir.create(parallel_consent)
    parallel_result <- file.path(parallel_root, c("one", "two"))
    parallel_children <- lapply(seq_along(parallel_result), function(index) {
        child_args <- c("--vanilla", "--slave", paste0("--file=", runner), "--args",
                        "parallel", parallel_root, repo, parallel_result[[index]])
        system2(r_binary, shQuote(child_args), wait = FALSE,
                stdout = file.path(parallel_root, paste0(index, "-out")),
                stderr = file.path(parallel_root, paste0(index, "-err")))
    })
    requests <- wait_requests(parallel_consent, 2L)
    answer_requests(requests, "approve")
    deadline <- Sys.time() + 30
    while (!all(file.exists(parallel_result)) && Sys.time() < deadline) Sys.sleep(0.01)
    if (!all(file.exists(parallel_result))) stop("Concurrent jgd preparation did not finish.")
    stopifnot(all(vapply(parallel_result, function(path) {
        identical(readLines(path, warn = FALSE), c("fixture-socket", "TRUE", "jgd"))
    }, FALSE)))
    stopifnot(length(readLines(file.path(parallel_root, "verify-log"), warn = FALSE)) == 1L)

    # Exercise the startup profile consumer separately: a declined optional tool
    # request must still let sess connect and publish a ready startup status.
    profile_root <- file.path(root, "profile-declined")
    dir.create(profile_root)
    profile_consent <- file.path(profile_root, "consent")
    dir.create(profile_consent)
    profile_log <- file.path(profile_root, "connect-log")
    stub_attach <- file.path(profile_root, "attach-helper.R")
    source_helper <- file.path(profile_root, "source-helper.R")
    installer_helper <- file.path(profile_root, "installer-helper.R")
    empty_user_profile <- file.path(profile_root, "empty-user-profile.R")
    file.create(source_helper, installer_helper, empty_user_profile)
    writeLines(c(
        "vscode_r_prepare_sess <- function(...) { ns <- new.env(); ns$connect <- function(...) {",
        paste0("  writeLines(c(Sys.getenv('JGD_SOCKET', unset=''), ",
               "as.character(requireNamespace('jgd', quietly=TRUE))), ",
               "", r_literal(profile_log), ")"),
        "  TRUE",
        "}; ns }"
    ), stub_attach)
    startup_file <- file.path(profile_root, "startup.status")
    startup_profile <- file.path(profile_root, "run-profile.R")
    writeLines(c(
        paste0("Sys.setenv(VSCODE_R_SESS_PKG_PATH=", r_literal(package), ","),
        paste0("  VSCODE_R_SESS_SOURCE_HELPER=", r_literal(source_helper), ","),
        paste0("  VSCODE_R_SESS_ATTACH_HELPER=", r_literal(stub_attach), ","),
        paste0("  VSCODE_R_SESS_INSTALLER_HELPER=", r_literal(installer_helper), ","),
        paste0("  VSCODE_R_SESS_ROOT=", r_literal(profile_root), ","),
        paste0("  VSCODE_R_SESS_CONSENT_DIRECTORY=", r_literal(profile_consent), ","),
        paste0("  VSCODE_R_SESS_STARTUP_FILE=", r_literal(startup_file), ","),
        "  VSCODE_R_SESS_STARTUP_TOKEN='0123456789abcdef0123456789abcdef',",
        "  VSCODE_R_SESS_STARTUP_ENDPOINT='fixture-endpoint',",
        paste0("  VSCODE_R_SESS_STARTUP_HELPER=", r_literal(file.path(getwd(), "R", "terminal-startup.R")), ","),
        paste0("  VSCODE_R_JGD_HELPER=", r_literal(file.path(getwd(), "R", "prepare-jgd.R")), ","),
        paste0("  VSCODE_R_TOOL_ROOT=", r_literal(file.path(profile_root, "tools")), ","),
        paste0("  VSCODE_R_TOOL_CONSENT_DIRECTORY=", r_literal(profile_consent), ","),
        paste0("  VSCODE_R_TOOL_LIBRARY_HELPER=", r_literal(file.path(getwd(), "R", "tool-library.R")), ","),
        paste0("  VSCODE_R_TOOL_CONSENT_HELPER=", r_literal(file.path(getwd(), "R", "tool-consent.R")), ","),
        paste0("  R_PROFILE_USER_OLD=", r_literal(empty_user_profile), ","),
        "  SESS_PLOT_BACKEND='jgd', JGD_SOCKET='fixture-socket')",
        paste0("options(repos=c(CRAN=", r_literal(repo), "), pkgType='source')"),
        "source(file.path(getwd(), 'R', 'profile.R'))"
    ), startup_profile)
    profile_result <- file.path(profile_root, "result")
    profile_process <- system2(r_binary, shQuote(c("--vanilla", "--slave", paste0("--file=", startup_profile))),
                               wait = FALSE, stdout = file.path(profile_root, "stdout"),
                               stderr = file.path(profile_root, "stderr"))
    request <- wait_requests(profile_consent, 1L)
    answer_requests(request, "decline")
    deadline <- Sys.time() + 30
    while (!file.exists(profile_log) && Sys.time() < deadline) Sys.sleep(0.01)
    if (!file.exists(profile_log)) stop("Declined startup profile did not connect sess.")
    stopifnot(identical(readLines(profile_log), c("", "FALSE")))
    startup_status <- readLines(startup_file, warn = FALSE)
    deadline <- Sys.time() + 10
    while (length(startup_status) == 6L && startup_status[[6L]] == "pending" &&
               Sys.time() < deadline) {
        Sys.sleep(0.01)
        startup_status <- readLines(startup_file, warn = FALSE)
    }
    if (length(startup_status) != 6L || startup_status[[6L]] != "ready") {
        logs <- unlist(lapply(c("stdout", "stderr"), function(name) {
            path <- file.path(profile_root, name)
            if (file.exists(path)) readLines(path, warn = FALSE) else character()
        }))
        stop("Unexpected profile startup status: ", paste(startup_status, collapse = " | "),
             " logs: ", paste(logs, collapse = "\n"))
    }

    cat("jgd preparation integration tests passed\n")
})
