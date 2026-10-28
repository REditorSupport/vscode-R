# Base-R integration coverage for optional jgd preparation during attach.
local({
    root <- tempfile("prepare-jgd-")
    dir.create(root)
    root <- normalizePath(root, winslash = "/", mustWork = TRUE)
    r_literal <- function(value) paste0("\"", gsub("\\\"", "\\\\\\\"", value), "\"")
    on.exit(unlink(root, recursive = TRUE), add = TRUE)
    ambient_library <- file.path(root, "ambient-user-library")
    isolated_child_env <- function(label, libraries = "") {
        user_library <- file.path(root, "isolated-libraries", label, "user")
        site_library <- file.path(root, "isolated-libraries", label, "site")
        dir.create(user_library, recursive = TRUE, showWarnings = FALSE)
        dir.create(site_library, recursive = TRUE, showWarnings = FALSE)
        c(R_LIBS_USER = user_library, R_LIBS_SITE = site_library,
          R_LIBS = libraries, VSCODE_R_TEST_AMBIENT_LIBRARY = ambient_library)
    }
    with_child_environment <- function(environment, expression) {
        stopifnot(is.character(environment), !is.null(names(environment)),
                  !anyNA(environment), !anyDuplicated(names(environment)))
        keys <- names(environment)
        previous <- Sys.getenv(keys, unset = NA_character_)
        on.exit({
            unset <- keys[is.na(previous)]
            if (length(unset)) Sys.unsetenv(unset)
            restore <- previous[!is.na(previous)]
            if (length(restore)) do.call(Sys.setenv, as.list(restore))
        }, add = TRUE)
        do.call(Sys.setenv, as.list(environment))
        force(expression)
    }
    system2_with_child_environment <- function(environment, command, args, ...) {
        arguments <- c(list(command = command, args = args), list(...))
        with_child_environment(environment, do.call(system2, arguments))
    }

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
            "  if (nzchar(path)) cat('jgd\\n', file=path, append=TRUE)",
            "  invisible(NULL)",
            "}"
        ), file.path(package, "R", "api.R"))
        writeLines(c("export(fixture_device)", "export(jgd)"), file.path(package, "NAMESPACE"))
        previous <- setwd(root)
        on.exit(setwd(previous), add = TRUE)
        output <- system2_with_child_environment(
            isolated_child_env(paste0("build-", version)),
            file.path(R.home("bin"), "R"),
            c("CMD", "build", "--no-build-vignettes", shQuote(basename(package))),
            stdout = TRUE, stderr = TRUE
        )
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
    unlink(file.path(root, "repo", "src", "contrib", "jgd_0.0.1.tar.gz"))
    tools::write_PACKAGES(file.path(root, "repo", "src", "contrib"), type = "source")
    repo <- paste0("file:///", sub("^/", "", normalizePath(file.path(root, "repo"), winslash = "/")))
    dir.create(ambient_library)
    ambient_install <- system2_with_child_environment(
        isolated_child_env("ambient-install"),
        file.path(R.home("bin"), "R"),
        c("CMD", "INSTALL", paste0("--library=", shQuote(ambient_library)),
          shQuote(file.path(root, "jgd-0.1.0"))),
        stdout = TRUE, stderr = TRUE
    )
    ambient_status <- attr(ambient_install, "status")
    if (!is.null(ambient_status) && ambient_status != 0L) {
        stop("Could not install ambient jgd fixture: ", paste(ambient_install, collapse = "\n"))
    }
    old_user_library <- Sys.getenv("R_LIBS_USER", unset = NA_character_)
    old_site_library <- Sys.getenv("R_LIBS_SITE", unset = NA_character_)
    Sys.setenv(R_LIBS_USER = ambient_library, R_LIBS_SITE = ambient_library)
    on.exit({
        if (is.na(old_user_library)) Sys.unsetenv("R_LIBS_USER") else
            Sys.setenv(R_LIBS_USER = old_user_library)
        if (is.na(old_site_library)) Sys.unsetenv("R_LIBS_SITE") else
            Sys.setenv(R_LIBS_SITE = old_site_library)
    }, add = TRUE)
    installed <- utils::installed.packages(lib.loc = .libPaths())
    runtime_dependencies <- unique(c(
        "processx", "later", "jsonlite",
        unlist(tools::package_dependencies(c("processx", "later", "jsonlite"),
                                           db = installed, which = c("Depends", "Imports"),
                                           recursive = TRUE), use.names = FALSE)
    ))
    dependency_library <- file.path(root, "runtime-dependencies")
    dir.create(dependency_library)
    for (dependency in setdiff(runtime_dependencies, rownames(installed)[installed[, "LibPath"] == .Library])) {
        rows <- which(rownames(installed) == dependency)
        if (!length(rows)) stop("Missing installed runtime test dependency: ", dependency)
        source_path <- file.path(installed[rows[[1L]], "LibPath"], dependency)
        if (!file.copy(source_path, dependency_library, recursive = TRUE)) {
            stop("Could not stage runtime test dependency: ", dependency)
        }
    }
    sess_library <- file.path(root, "sess-library")
    dir.create(sess_library)
    sess_install <- system2_with_child_environment(
        isolated_child_env("sess-install", dependency_library),
        file.path(R.home("bin"), "R"),
        c("CMD", "INSTALL", paste0("--library=", shQuote(sess_library)),
          shQuote(file.path(getwd(), "sess"))),
        stdout = TRUE, stderr = TRUE
    )
    sess_status <- attr(sess_install, "status")
    if (!is.null(sess_status) && sess_status != 0L) {
        stop("Could not install sess test fixture: ", paste(sess_install, collapse = "\n"))
    }
    runner <- file.path(root, "run.R")
    writeLines(c(
        "args <- commandArgs(TRUE); mode <- args[[1L]]; root <- args[[2L]]; repo <- args[[3L]];",
        "result <- args[[4L]];",
        "ambient <- normalizePath(Sys.getenv('VSCODE_R_TEST_AMBIENT_LIBRARY'), winslash='/');",
        "stopifnot(!ambient %in% normalizePath(.libPaths(), winslash='/'));",
        "source(file.path(getwd(), 'R', 'tool-library.R'));",
        "source(file.path(getwd(), 'R', 'tool-consent.R'));",
        "source(file.path(getwd(), 'R', 'prepare-tools.R'));",
        "source(file.path(getwd(), 'R', 'attach_sess.R'));",
        "options(repos=c(CRAN=repo), pkgType='source');",
        "consent <- file.path(root, 'consent'); dir.create(consent, showWarnings=FALSE);",
        # Manual attach must use its supplied minimum rather than an inherited terminal value.
        "Sys.setenv(JGD_SOCKET='fixture-socket', VSCODE_R_JGD_MINIMUM_VERSION='9.9.9');",
        "connect_seen <- new.env();",
        "device_log <- file.path(root, paste0(mode, '-device-log'));",
        "Sys.setenv(JGD_TEST_DEVICE_LOG=device_log);",
        "vscode_r_prepare_sess <- function(...) { ns <- new.env(); ns$connect <- function(allow_jgd=TRUE, ...) {",
        "  connect_seen$allow_jgd <- allow_jgd;",
        "  if (mode == 'socket-empty') Sys.setenv(JGD_SOCKET='fixture-socket');",
        "  connect_seen$socket <- Sys.getenv('JGD_SOCKET', unset='');",
        "  connect_seen$loaded <- requireNamespace('jgd', quietly=TRUE);",
        "  hooks <- new.env(parent=globalenv());",
        "  sys.source(file.path(getwd(), 'sess', 'R', 'hooks.R'), hooks);",
        "  has_jgd <- connect_seen$allow_jgd && nzchar(connect_seen$socket) && connect_seen$loaded;",
        "  connect_seen$device <- hooks$.select_plot_backend('jgd', FALSE, has_jgd);",
        "  if (connect_seen$device == 'jgd') jgd::jgd(); TRUE }; ns };",
        "if (mode == 'old') {",
        "  old <- file.path(root, 'old-library'); dir.create(old);",
        "  utils::install.packages(file.path(root, 'jgd-0.0.1'), repos=NULL, type='source', lib=old, quiet=TRUE);",
        "  .libPaths(c(old, .Library)); loadNamespace('jgd', lib.loc=old);",
        "}",
        "if (mode == 'offline') options(repos=c(CRAN=file.path(root, 'missing-repo')));",
        "if (mode == 'socket-empty') Sys.unsetenv('JGD_SOCKET');",
        "tool_library_helper <- if (mode %in% c('parallel', 'no-prompt', 'no-prompt-compatible'))",
        "  file.path(root, 'instrumented-tool-library.R') else",
        "  file.path(getwd(), 'R', 'tool-library.R');",
        "if (mode == 'library-helper-missing') tool_library_helper <- file.path(root, 'missing-tool-library.R');",
        "if (mode == 'no-prompt-compatible') {",
        "  ordinary <- file.path(root, 'ordinary-library'); dir.create(ordinary);",
        "  utils::install.packages('jgd', repos=repo, type='source', lib=ordinary, quiet=TRUE);",
        "  .libPaths(c(ordinary, .libPaths()));",
        "}",
        "timeout_before <- getOption('timeout'); libraries_before <- .libPaths();",
        "answer <- vscode_r_attach_sess('endpoint', 'unused', file.path(root, 'tools'), consent,",
        "  'unused', 'unused', 'jgd', timeout_seconds=0, use_rstudioapi=FALSE,",
        "  tool_root=file.path(root, 'tools'),",
        "  tool_consent_directory=consent, tool_library_helper=tool_library_helper,",
        "  tool_consent_helper=file.path(getwd(), 'R', 'tool-consent.R'),",
        "  tool_prepare_helper=if (mode == 'helper-missing') file.path(root, 'missing-prepare-tools.R') else",
        "    file.path(getwd(), 'R', 'prepare-tools.R'),",
        "  jgd_can_prompt=!(mode %in% c('no-prompt', 'no-prompt-compatible', 'socket-empty')),",
        "  jgd_minimum_version='0.1.0');",
        "stopifnot(isTRUE(answer), identical(Sys.getenv('JGD_SOCKET'), 'fixture-socket'));",
        "stopifnot(identical(getOption('timeout'), timeout_before), identical(.libPaths(), libraries_before));",
        "writeLines(c(connect_seen$socket, as.character(connect_seen$loaded), connect_seen$device,",
        "            as.character(connect_seen$allow_jgd)), result);"
    ), runner)

    r_binary <- file.path(R.home("bin"), "R")
    run_child <- function(mode, result) {
        child_args <- c("--vanilla", "--slave", paste0("--file=", runner), "--args",
                        mode, root, repo, result)
        output <- system2_with_child_environment(isolated_child_env(mode), r_binary,
                                                 shQuote(child_args), stdout = TRUE, stderr = TRUE)
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

    dir.create(file.path(root, "consent"), showWarnings = FALSE)
    real_runner <- file.path(root, "real-connect.R")
    writeLines(c(
        "args <- commandArgs(TRUE); mode <- args[[1L]]; root <- args[[2L]]; repo <- args[[3L]];",
        "result <- args[[4L]]; sess_library <- args[[5L]];",
        "ambient <- normalizePath(Sys.getenv('VSCODE_R_TEST_AMBIENT_LIBRARY'), winslash='/');",
        "stopifnot(!ambient %in% normalizePath(.libPaths(), winslash='/'));",
        "source(file.path(getwd(), 'R', 'tool-library.R'));",
        "source(file.path(getwd(), 'R', 'tool-consent.R'));",
        "source(file.path(getwd(), 'R', 'prepare-tools.R'));",
        "source(file.path(getwd(), 'R', 'attach_sess.R'));",
        "options(repos=c(CRAN=repo), pkgType='source', sess.quiet=TRUE);",
        "sess_ns <- loadNamespace('sess', lib.loc=sess_library);",
        "endpoint <- if (.Platform$OS.type == 'windows')",
        "  paste0('\\\\\\\\?\\\\pipe\\\\', basename(tempfile('sess-jgd-'))) else tempfile(fileext='.sock');",
        "server <- processx::conn_create_unix_socket(endpoint);",
        "discovery <- file.path(root, paste0(mode, '-discovery.json'));",
        "writeLines(jsonlite::toJSON(list(version=1L, endpoint=endpoint, jgdSocket='fixture-jgd-socket'),",
        "                            auto_unbox=TRUE), discovery);",
        "Sys.setenv(SESS_DISCOVERY_FILE=discovery, JGD_TEST_DEVICE_LOG=file.path(root, paste0(mode, '-real-device')));",
        "Sys.unsetenv('JGD_SOCKET');",
        "old_library <- file.path(root, paste0(mode, '-old-library')); dir.create(old_library);",
        "if (mode %in% c('real-loaded-old', 'real-user-old'))",
        "  utils::install.packages(file.path(root, 'jgd-0.0.1'), repos=NULL,",
        "                         type='source', lib=old_library, quiet=TRUE);",
        "if (mode == 'real-loaded-old') loadNamespace('jgd', lib.loc=old_library);",
        "if (mode == 'real-user-old') .libPaths(c(old_library, .libPaths()));",
        "connect_env <- new.env(parent=sess_ns); connect_env$.sess_env <- sess_ns$.sess_env;",
        "connect_env$connect <- getExportedValue('sess', 'connect');",
        "environment(connect_env$connect) <- connect_env;",
        "connect_env$.schedule_reconnect <- sess_ns$.schedule_reconnect;",
        "environment(connect_env$.schedule_reconnect) <- connect_env;",
        "connect_env$.reconnect_with_startup <- sess_ns$.reconnect_with_startup;",
        "environment(connect_env$.reconnect_with_startup) <- connect_env;",
        "connect_env$poll_connection <- function(...) {",
        "  processx::poll(list(server), 1000L); processx::conn_accept_unix_socket(server);",
        "  processx::poll(list(server), 1000L); message <- processx::conn_read_chars(server);",
        "  stopifnot(grepl('\\\"method\\\":\\\"attach\\\"', message)); invisible(NULL)",
        "};",
        "answer <- vscode_r_with_jgd('jgd', function(allow_jgd=TRUE)",
        "  connect_env$connect(endpoint=endpoint, use_rstudioapi=FALSE,",
        "                       plot_backend='jgd', allow_jgd=allow_jgd),",
        "  tool_prepare_helper=file.path(getwd(), 'R', 'prepare-tools.R'),",
        "  tool_root=file.path(root, paste0(mode, '-tools')),",
        "  tool_consent_directory=file.path(root, 'consent'),",
        "  tool_library_helper=file.path(getwd(), 'R', 'tool-library.R'),",
        "  tool_consent_helper=file.path(getwd(), 'R', 'tool-consent.R'),",
        "  can_prompt=identical(mode, 'real-approved'), minimum_version='0.1.0');",
        "allow <- sess_ns$.sess_env$reconnect$options$allow_jgd;",
        "socket <- Sys.getenv('JGD_SOCKET', unset='');",
        "loaded <- 'jgd' %in% loadedNamespaces();",
        "getOption('device')();",
        "settings <- sess_ns$.sess_env$reconnect;",
        "sess_ns$.transport_disconnect(silent=TRUE); close(server);",
        "next_endpoint <- if (.Platform$OS.type == 'windows')",
        "  paste0('\\\\\\\\?\\\\pipe\\\\', basename(tempfile('sess-jgd-next-'))) else tempfile(fileext='.sock');",
        "server <- processx::conn_create_unix_socket(next_endpoint);",
        "writeLines(jsonlite::toJSON(list(version=1L, endpoint=next_endpoint,",
        "  jgdSocket='fixture-jgd-socket-next'), auto_unbox=TRUE), discovery);",
        "scheduled <- NULL;",
        "connect_env$.schedule_reconnect(settings, schedule=function(callback, delay) { scheduled <<- callback });",
        "stopifnot(is.function(scheduled)); scheduled();",
        "next_allow <- sess_ns$.sess_env$reconnect$options$allow_jgd;",
        "next_socket <- Sys.getenv('JGD_SOCKET', unset='');",
        "next_loaded <- 'jgd' %in% loadedNamespaces();",
        "getOption('device')();",
        "writeLines(c(as.character(answer), as.character(allow), socket, as.character(loaded),",
        "             as.character(next_allow), next_socket, as.character(next_loaded)), result);",
        "sess_ns$.transport_disconnect(silent=TRUE); close(server)"
    ), real_runner)

    run_real_child <- function(mode, result, wait = TRUE) {
        args <- c("--vanilla", "--slave", paste0("--file=", real_runner), "--args",
                  mode, root, repo, result, sess_library)
        system2_with_child_environment(
            isolated_child_env(paste0("real-", mode),
                               paste(sess_library, dependency_library, sep = .Platform$path.sep)),
            r_binary, shQuote(args), wait = wait,
            stdout = if (wait) TRUE else file.path(root, paste0(mode, "-out")),
            stderr = if (wait) TRUE else file.path(root, paste0(mode, "-err"))
        )
    }

    for (mode in c("real-loaded-old", "real-user-old")) {
        result <- file.path(root, paste0(mode, "-result"))
        output <- run_real_child(mode, result)
        status <- attr(output, "status")
        if (!is.null(status) && status != 0L) stop(paste(output, collapse = "\n"))
        values <- readLines(result, warn = FALSE)
        stopifnot(identical(values[c(1L, 2L, 3L)], c("TRUE", "FALSE", "")))
        stopifnot(identical(values[[4L]], as.character(identical(mode, "real-loaded-old"))))
        stopifnot(identical(values[c(5L, 6L)], c("FALSE", "")))
        stopifnot(identical(values[[7L]], values[[4L]]))
        stopifnot(!file.exists(file.path(root, paste0(mode, "-real-device"))))
    }

    approved_real_result <- file.path(root, "real-approved-result")
    real_process <- run_real_child("real-approved", approved_real_result, wait = FALSE)
    real_request <- wait_requests(file.path(root, "consent"), 1L)
    answer_requests(real_request, "approve")
    deadline <- Sys.time() + 30
    while (!file.exists(approved_real_result) && Sys.time() < deadline) Sys.sleep(0.01)
    if (!file.exists(approved_real_result)) {
        logs <- unlist(lapply(c("real-approved-out", "real-approved-err"), function(name) {
            path <- file.path(root, name)
            if (file.exists(path)) readLines(path, warn = FALSE) else character()
        }))
        stop("Actual sess jgd connection did not finish: ", paste(logs, collapse = "\n"))
    }
    stopifnot(identical(readLines(approved_real_result, warn = FALSE),
                        c("TRUE", "TRUE", "fixture-jgd-socket", "TRUE", "TRUE",
                          "fixture-jgd-socket-next", "TRUE")))
    stopifnot(identical(readLines(file.path(root, "real-approved-real-device"), warn = FALSE),
                        c("jgd", "jgd")))

    approved_root <- file.path(root, "approved")
    dir.create(approved_root)
    approved_result <- file.path(root, "approved-result")
    approved_args <- c("--vanilla", "--slave", paste0("--file=", runner), "--args",
                       "approved", approved_root, repo, approved_result)
    approved_process <- system2_with_child_environment(
        isolated_child_env("approved"), r_binary, shQuote(approved_args), wait = FALSE,
        stdout = file.path(root, "approved-out"), stderr = file.path(root, "approved-err")
    )
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
    stopifnot(identical(readLines(approved_result), c("fixture-socket", "TRUE", "jgd", "TRUE")))
    stopifnot(identical(readLines(file.path(approved_root, "approved-device-log")), "jgd"))

    declined_root <- file.path(root, "declined")
    dir.create(declined_root)
    declined_result <- file.path(root, "declined-result")
    declined_args <- c("--vanilla", "--slave", paste0("--file=", runner), "--args",
                       "declined", declined_root, repo, declined_result)
    declined_process <- system2_with_child_environment(
        isolated_child_env("declined"), r_binary, shQuote(declined_args), wait = FALSE,
        stdout = file.path(root, "declined-out"), stderr = file.path(root, "declined-err")
    )
    request <- wait_requests(file.path(declined_root, "consent"), 1L)
    answer_requests(request, "decline")
    deadline <- Sys.time() + 30
    while (!file.exists(declined_result) && Sys.time() < deadline) Sys.sleep(0.01)
    if (!file.exists(declined_result)) stop("Declined jgd attach did not finish.")
    stopifnot(identical(readLines(declined_result), c("fixture-socket", "FALSE", "standard", "FALSE")))

    for (mode in c("old", "offline", "helper-missing", "library-helper-missing", "socket-empty")) {
        result <- file.path(root, paste0(mode, "-result"))
        observed <- run_child(mode, result)
        expected_socket <- "fixture-socket"
        expected <- c(expected_socket, if (mode == "old") "TRUE" else "FALSE",
                      "standard", "FALSE")
        if (!identical(observed, expected)) {
            stop(mode, " expected ", paste(expected, collapse = " | "), " observed ",
                 paste(observed, collapse = " | "))
        }
        stopifnot(length(list.files(file.path(root, mode, "consent"), pattern = "\\.request$")) == 0L)
    }

    for (mode in c("no-prompt", "no-prompt-compatible")) {
        plan_marker <- file.path(root, paste0(mode, "-plan-called"))
        helper_lines <- readLines(file.path(getwd(), "R", "tool-library.R"), warn = FALSE)
        helper_lines <- c(helper_lines,
                          paste0("tool_library_plan <- function(...) { file.create(",
                                 r_literal(plan_marker), "); stop('unexpected metadata resolution') }"))
        writeLines(helper_lines, file.path(root, "instrumented-tool-library.R"))
        result <- file.path(root, paste0(mode, "-result"))
        observed <- run_child(mode, result)
        if (mode == "no-prompt") {
            stopifnot(identical(observed, c("fixture-socket", "FALSE", "standard", "FALSE")))
        } else {
            stopifnot(identical(observed, c("fixture-socket", "TRUE", "jgd", "TRUE")))
            stopifnot(identical(readLines(file.path(root, paste0(mode, "-device-log"))), "jgd"))
        }
        stopifnot(length(list.files(file.path(root, "consent"), pattern = "\\.request$")) == 0L)
        stopifnot(!file.exists(plan_marker))
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
        system2_with_child_environment(
            isolated_child_env(paste0("parallel-", index)), r_binary, shQuote(child_args), wait = FALSE,
            stdout = file.path(parallel_root, paste0(index, "-out")),
            stderr = file.path(parallel_root, paste0(index, "-err"))
        )
    })
    requests <- wait_requests(parallel_consent, 2L)
    answer_requests(requests, "approve")
    deadline <- Sys.time() + 30
    while (!all(file.exists(parallel_result)) && Sys.time() < deadline) Sys.sleep(0.01)
    if (!all(file.exists(parallel_result))) stop("Concurrent jgd preparation did not finish.")
    stopifnot(all(vapply(parallel_result, function(path) {
        identical(readLines(path, warn = FALSE), c("fixture-socket", "TRUE", "jgd", "TRUE"))
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
        "source(file.path(getwd(), 'R', 'attach_sess.R'))",
        "vscode_r_prepare_sess <- function(...) { ns <- new.env(); ns$connect <- function(allow_jgd=TRUE, ...) {",
        paste0("  writeLines(c(Sys.getenv('JGD_SOCKET', unset=''), ",
               "as.character(requireNamespace('jgd', quietly=TRUE)), as.character(allow_jgd)), ",
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
        paste0("  VSCODE_R_TOOL_PREPARE_HELPER=", r_literal(file.path(getwd(), "R", "prepare-tools.R")), ","),
        paste0("  VSCODE_R_TOOL_ROOT=", r_literal(file.path(profile_root, "tools")), ","),
        paste0("  VSCODE_R_TOOL_CONSENT_DIRECTORY=", r_literal(profile_consent), ","),
        paste0("  VSCODE_R_TOOL_LIBRARY_HELPER=", r_literal(file.path(getwd(), "R", "tool-library.R")), ","),
        paste0("  VSCODE_R_TOOL_CONSENT_HELPER=", r_literal(file.path(getwd(), "R", "tool-consent.R")), ","),
        "  VSCODE_R_JGD_CAN_PROMPT='TRUE',",
        "  VSCODE_R_JGD_MINIMUM_VERSION='0.1.0',",
        paste0("  R_PROFILE_USER_OLD=", r_literal(empty_user_profile), ","),
        "  SESS_PLOT_BACKEND='jgd', SESS_RSTUDIOAPI='FALSE', JGD_SOCKET='fixture-socket')",
        paste0("options(repos=c(CRAN=", r_literal(repo), "), pkgType='source')"),
        "source(file.path(getwd(), 'R', 'profile.R'))"
    ), startup_profile)
    profile_result <- file.path(profile_root, "result")
    profile_process <- system2_with_child_environment(
        isolated_child_env("profile"), r_binary,
        shQuote(c("--vanilla", "--slave", paste0("--file=", startup_profile))),
        wait = FALSE, stdout = file.path(profile_root, "stdout"),
        stderr = file.path(profile_root, "stderr")
    )
    request <- wait_requests(profile_consent, 1L)
    answer_requests(request, "decline")
    deadline <- Sys.time() + 30
    while (!file.exists(profile_log) && Sys.time() < deadline) Sys.sleep(0.01)
    if (!file.exists(profile_log)) stop("Declined startup profile did not connect sess.")
    stopifnot(identical(readLines(profile_log), c("fixture-socket", "FALSE", "FALSE")))
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
