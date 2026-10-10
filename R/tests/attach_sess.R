# Base-R integration coverage for manual attach consent; packages are local fixtures.
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
    "connect <- function(endpoint, plot_backend) list(endpoint = endpoint, plot_backend = plot_backend)",
    "notify_client <- function(...) NULL", "request_client <- function(...) NULL"
), file.path(pkg, "R", "api.R"))
writeLines(c("export(connect)", "export(notify_client)", "export(request_client)"), file.path(pkg, "NAMESPACE"))

runner <- file.path(root, "run-case.R")
writeLines(c(
    "args <- commandArgs(TRUE)",
    "mode <- args[[1L]]; root <- args[[2L]]; pkg <- args[[3L]]; revision <- args[[4L]]; mismatch <- args[[5L]]",
    "source(file.path(getwd(), 'R', 'sess_source.R'))",
    "source(file.path(getwd(), 'R', 'attach_sess.R'))",
    "normal <- file.path(root, 'normal library'); dir.create(normal, recursive=TRUE)",
    "consent <- file.path(root, 'consent'); dir.create(consent, recursive=TRUE, showWarnings=FALSE)",
    "managed_root <- file.path(root, 'vscode-R')",
    "Sys.setenv(R_LIBS_USER=file.path(root, 'empty user library'), R_LIBS_SITE=.Library)",
    "original <- .Library; .libPaths(c(normal, original)); ordinary <- .libPaths()",
    "if (mode %in% c('exact', 'prepared')) {",
    "  library <- if (mode == 'exact') normal else sess_managed_library(managed_root, revision)",
    "  dir.create(library, recursive=TRUE, showWarnings=FALSE)",
    "  utils::install.packages(pkg, repos=NULL, type='source', lib=library, quiet=TRUE)",
    "}",
    "if (mode == 'twice') {",
    "  utils::install.packages(pkg, repos=NULL, type='source', lib=normal, quiet=TRUE)",
    "  desc <- read.dcf(file.path(normal, 'sess', 'DESCRIPTION'))",
    "  desc[1L, 'Config/vscode-R/source-revision'] <- mismatch",
    "  write.dcf(desc, file.path(normal, 'sess', 'DESCRIPTION'))",
    "  stopifnot(identical(sess_source_revision(file.path(normal, 'sess', 'DESCRIPTION')), mismatch))",
    "  for (i in 1:2) { set.seed(8841); seed <- .Random.seed; result <- vscode_r_attach_sess('endpoint', pkg, managed_root, consent, file.path(getwd(), 'R', 'sess_source.R'), file.path(getwd(), 'R', 'sess-package-install.R'), 'standard', timeout_seconds=8); if (!identical(result, FALSE)) stop(paste('unexpected result', mode, i, paste(capture.output(str(result)), collapse=' '), 'source', sess_installed_source_revision(ordinary))); stopifnot(identical(seed, .Random.seed), identical(.libPaths(), ordinary)) }",
    "  stopifnot(identical(read.dcf(file.path(normal, 'sess', 'DESCRIPTION')), desc), !dir.exists(sess_managed_library(managed_root, revision)))",
    "} else if (mode %in% c('exact', 'prepared')) {",
    "  expected <- if (mode == 'exact') normal else sess_managed_library(managed_root, revision)",
    "  result <- vscode_r_attach_sess('endpoint', pkg, managed_root, consent, file.path(getwd(), 'R', 'sess_source.R'), file.path(getwd(), 'R', 'sess-package-install.R'), 'standard', timeout_seconds=0)",
    "  stopifnot(identical(result, TRUE), identical(.libPaths(), ordinary), identical(sess_loaded_source_revision(), revision))",
    "  stopifnot(identical(normalizePath(getNamespaceInfo(asNamespace('sess'), 'path')), normalizePath(file.path(expected, 'sess'))))",
    "  stopifnot(length(list.files(consent, pattern='\\\\.request$')) == 0L)",
    "} else if (mode == 'timeout') {",
    "  set.seed(8841); seed <- .Random.seed",
    "  result <- vscode_r_attach_sess('endpoint', pkg, managed_root, consent, file.path(getwd(), 'R', 'sess_source.R'), file.path(getwd(), 'R', 'sess-package-install.R'), 'standard', timeout_seconds=0)",
    "  stopifnot(identical(result, FALSE), identical(seed, .Random.seed), identical(.libPaths(), ordinary))",
    "  stopifnot(!dir.exists(sess_managed_library(managed_root, revision)), length(list.files(consent, pattern='\\\\.request$')) == 0L)",
    "} else if (mode == 'approve') {",
    "  wrong_library <- file.path(managed_root, 'fixture-other-platform', '99.99', strrep('a', 40), 'library')",
    "  dir.create(wrong_library, recursive=TRUE, showWarnings=FALSE)",
    "  utils::install.packages(pkg, repos=NULL, type='source', lib=wrong_library, quiet=TRUE)",
    "  set.seed(8841); seed <- .Random.seed",
    "  result <- vscode_r_attach_sess('endpoint', pkg, managed_root, consent, file.path(getwd(), 'R', 'sess_source.R'), file.path(getwd(), 'R', 'sess-package-install.R'), 'standard', timeout_seconds=20)",
    "  library <- sess_managed_library(managed_root, revision)",
    "  stopifnot(identical(result, TRUE), identical(.libPaths(), ordinary), identical(sess_loaded_source_revision(), revision))",
    "  stopifnot(identical(normalizePath(getNamespaceInfo(asNamespace('sess'), 'path')), normalizePath(file.path(library, 'sess'))))",
    "  stopifnot(file.exists(file.path(library, 'sess', 'DESCRIPTION')), !dir.exists(file.path(normal, 'sess')))",
    "  stopifnot(file.exists(file.path(wrong_library, 'sess', 'DESCRIPTION')), identical(sess_source_revision(file.path(wrong_library, 'sess', 'DESCRIPTION')), revision))",
    "} else stop('unknown case')",
    "cat('manual attach case passed:', mode, '\\n')"
), runner)

agent <- file.path(root, "consent-agent.R")
writeLines(c(
    "args <- commandArgs(TRUE); directory <- args[[1L]]; count <- as.integer(args[[2L]]); answer <- args[[3L]]; log <- args[[4L]]",
    "ids <- character(); deadline <- Sys.time() + 30",
    "while (length(ids) < count && Sys.time() < deadline) {",
    "  requests <- list.files(directory, pattern='\\\\.request$', full.names=TRUE)",
    "  for (request in requests) {",
    "    lines <- readLines(request, warn=FALSE)",
    "    if (length(lines) != 5L || lines[[1L]] != 'vscode-r-sess-consent-v1') stop('bad consent request')",
    "    id <- lines[[2L]]; if (id %in% ids) next",
    "    ids <- c(ids, id); temporary <- tempfile(tmpdir=directory)",
    "    writeLines(answer, temporary); if (!file.rename(temporary, file.path(directory, paste0(id, '.response')))) stop('response rename failed')",
    "  }",
    "  Sys.sleep(0.025)",
    "}",
    "if (length(ids) != count) stop('timed out waiting for consent requests')",
    "writeLines(ids, log)"
), agent)

r_binary <- file.path(R.home("bin"), if (.Platform$OS.type == "windows") "R.exe" else "R")
run_case <- function(mode) {
    case_root <- file.path(root, mode)
    dir.create(case_root)
    consent <- file.path(case_root, "consent")
    dir.create(consent)
    if (mode %in% c("approve", "twice")) {
        log <- file.path(case_root, "consent-ids")
        count <- if (mode == "twice") 2L else 1L
        answer <- if (mode == "twice") "decline" else "approve"
        system2(r_binary, shQuote(c("--vanilla", "--slave", paste0("--file=", agent), "--args", consent,
                                    as.character(count), answer, log)),
                wait = FALSE, stdout = FALSE, stderr = FALSE)
    }
    output <- suppressWarnings(system2(r_binary, shQuote(c(
        "--vanilla", "--slave", "--no-save", "--no-restore", paste0("--file=", runner), "--args",
        mode, case_root, pkg, revision, mismatch
    )), stdout = TRUE, stderr = TRUE))
    status <- attr(output, "status")
    if (!is.null(status) && status != 0L) stop(paste(output, collapse="\n"))
    if (mode %in% c("approve", "twice")) {
        log_path <- file.path(case_root, "consent-ids")
        deadline <- Sys.time() + 5
        while (!file.exists(log_path) && Sys.time() < deadline) Sys.sleep(0.01)
        stopifnot(file.exists(log_path))
        ids <- readLines(log_path, warn=FALSE)
        stopifnot(length(ids) == if (mode == "twice") 2L else 1L,
                  !anyDuplicated(ids), all(grepl("^[A-Za-z0-9_-]{16,64}$", ids)))
    }
}

for (mode in c("twice", "exact", "prepared", "timeout", "approve")) run_case(mode)
unlink(root, recursive = TRUE)
cat("manual attach consent bridge tests passed\n")
