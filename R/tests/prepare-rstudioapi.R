# Base-R integration coverage for optional rstudioapi preparation during attach
# and terminal startup. All packages are local fixtures served from a file repository.
local({
    root <- tempfile("prepare-rstudioapi-")
    dir.create(root)
    root <- normalizePath(root, winslash = "/", mustWork = TRUE)
    on.exit(unlink(root, recursive = TRUE), add = TRUE)
    r_literal <- function(value) paste0("\"", gsub("\\\"", "\\\\\\\"", value), "\"")
    r_binary <- file.path(R.home("bin"), "R")
    minimum_version <- "0.4.0"
    ambient_library <- file.path(root, "ambient-user-library")
    dir.create(ambient_library)
    isolated_child_env <- function(label) {
        user_library <- file.path(root, "isolated-libraries", label, "user")
        site_library <- file.path(root, "isolated-libraries", label, "site")
        dir.create(user_library, recursive = TRUE, showWarnings = FALSE)
        dir.create(site_library, recursive = TRUE, showWarnings = FALSE)
        c(R_LIBS_USER = user_library, R_LIBS_SITE = site_library, R_LIBS = "")
    }
    system2_with_child_environment <- function(environment, command, args, ...) {
        keys <- names(environment)
        previous <- Sys.getenv(keys, unset = NA_character_)
        on.exit({
            unset <- keys[is.na(previous)]
            if (length(unset)) Sys.unsetenv(unset)
            restore <- previous[!is.na(previous)]
            if (length(restore)) do.call(Sys.setenv, as.list(restore))
        }, add = TRUE)
        do.call(Sys.setenv, as.list(environment))
        system2(command, args, ...)
    }

    # Fixtures: rstudioapi 0.4.0 is published, 0.3.1 exists only as a local source
    # directory below the minimum. jgd 0.1.0 is published for the combined startup.
    fixture_package <- function(package, version, publish) {
        directory <- file.path(root, "fixtures", paste0(package, "-", version))
        dir.create(file.path(directory, "R"), recursive = TRUE)
        writeLines(c(
            paste0("Package: ", package), paste0("Version: ", version),
            paste0("Title: ", package, " fixture"),
            paste0("Description: Local ", package, " fixture."), "License: MIT",
            "Author: Test Author", "Maintainer: Test Author <test@example.com>",
            "Encoding: UTF-8"
        ), file.path(directory, "DESCRIPTION"))
        writeLines("fixture_value <- function() 'fixture'", file.path(directory, "R", "api.R"))
        writeLines("export(fixture_value)", file.path(directory, "NAMESPACE"))
        if (publish) {
            previous <- setwd(dirname(directory))
            on.exit(setwd(previous), add = TRUE)
            output <- system2_with_child_environment(
                isolated_child_env(paste0("build-", package, "-", version)), r_binary,
                c("CMD", "build", "--no-build-vignettes", shQuote(basename(directory))),
                stdout = TRUE, stderr = TRUE
            )
            status <- attr(output, "status")
            if (!is.null(status) && status != 0L) stop(paste(output, collapse = "\n"))
            contrib <- file.path(root, "repo", "src", "contrib")
            dir.create(contrib, recursive = TRUE, showWarnings = FALSE)
            archive <- file.path(dirname(directory), paste0(package, "_", version, ".tar.gz"))
            stopifnot(file.copy(archive, contrib))
        }
        directory
    }
    fixture_package("rstudioapi", minimum_version, publish = TRUE)
    fixture_package("rstudioapi", "0.3.1", publish = FALSE)
    fixture_package("jgd", "0.1.0", publish = TRUE)
    tools::write_PACKAGES(file.path(root, "repo", "src", "contrib"), type = "source")
    repo <- paste0("file:///", sub("^/", "", normalizePath(file.path(root, "repo"), winslash = "/")))
    fixtures <- file.path(root, "fixtures")

    # The child records what sess would observe when connect() runs.
    runner <- file.path(root, "run-attach.R")
    writeLines(c(
        "args <- commandArgs(TRUE); mode <- args[[1L]]; root <- args[[2L]]; repo <- args[[3L]];",
        "result <- args[[4L]]; fixtures <- args[[5L]];",
        "source(file.path(getwd(), 'R', 'tool-library.R'));",
        "source(file.path(getwd(), 'R', 'tool-consent.R'));",
        "source(file.path(getwd(), 'R', 'attach_sess.R'));",
        "options(repos=c(CRAN=repo), pkgType='source');",
        "if (mode == 'offline') options(repos=c(CRAN=file.path(root, 'missing-repo')));",
        "work <- file.path(root, mode);",
        "consent <- file.path(work, 'consent'); dir.create(consent);",
        "install_fixture <- function(name, label) {",
        "  library <- file.path(work, label); dir.create(library);",
        "  utils::install.packages(file.path(fixtures, name), repos=NULL, type='source',",
        "                         lib=library, quiet=TRUE);",
        "  .libPaths(c(library, .libPaths())); library",
        "};",
        "if (mode %in% c('no-prompt-compatible', 'loaded-compatible'))",
        "  loaded_from <- install_fixture('rstudioapi-0.4.0', 'ordinary-library');",
        "if (mode == 'loaded-compatible') loadNamespace('rstudioapi', lib.loc=loaded_from);",
        "if (mode == 'loaded-incompatible') {",
        "  loaded_from <- install_fixture('rstudioapi-0.3.1', 'old-library');",
        "  loadNamespace('rstudioapi', lib.loc=loaded_from);",
        "}",
        # Record metadata resolution without changing what the helper does.
        "marker <- file.path(work, 'plan-called');",
        "instrumented <- file.path(work, 'tool-library.R');",
        "writeLines(c(readLines(file.path(getwd(), 'R', 'tool-library.R'), warn=FALSE),",
        "  'tool_library_plan_original <- tool_library_plan',",
        "  paste0('tool_library_plan <- function(...) { file.create(',",
        "         deparse(marker), '); tool_library_plan_original(...) }')), instrumented);",
        "seen <- new.env();",
        "vscode_r_prepare_sess <- function(...) { ns <- new.env();",
        "  ns$connect <- function(allow_jgd=TRUE, ...) {",
        "    seen$called <- TRUE; seen$allow_jgd <- allow_jgd;",
        "    seen$rstudioapi <- 'rstudioapi' %in% loadedNamespaces();",
        "    seen$jgd <- 'jgd' %in% loadedNamespaces();",
        "    seen$path <- if (seen$rstudioapi)",
        "      normalizePath(getNamespaceInfo('rstudioapi', 'path'), winslash='/') else '';",
        "    seen$version <- if (seen$rstudioapi)",
        "      as.character(getNamespaceVersion(asNamespace('rstudioapi'))) else '';",
        "    seen$require <- requireNamespace('rstudioapi', quietly=TRUE);",
        "    TRUE",
        "  }; ns };",
        "libraries_before <- .libPaths();",
        "can_prompt <- !(mode %in% c('no-prompt', 'no-prompt-compatible'));",
        "plot_backend <- switch(mode, both='auto', 'both-explicit'='jgd', 'standard');",
        "answer <- vscode_r_attach_sess('endpoint', 'unused', file.path(work, 'managed'), consent,",
        "  'unused', 'unused', plot_backend, timeout_seconds=0,",
        "  use_rstudioapi=mode != 'disabled',",
        "  tool_root=file.path(work, 'tools'), tool_consent_directory=consent,",
        "  tool_library_helper=instrumented,",
        "  tool_consent_helper=file.path(getwd(), 'R', 'tool-consent.R'),",
        "  tool_prepare_helper=file.path(getwd(), 'R', 'prepare-tools.R'),",
        "  jgd_can_prompt=can_prompt, jgd_minimum_version='0.1.0',",
        "  rstudioapi_can_prompt=can_prompt, rstudioapi_minimum_version='0.4.0');",
        "stopifnot(isTRUE(answer), isTRUE(seen$called), identical(.libPaths(), libraries_before));",
        "tool_path <- tool_library_path(file.path(work, 'tools'));",
        "writeLines(c(as.character(seen$rstudioapi), seen$path, seen$version,",
        "  as.character(seen$require), as.character(seen$jgd), as.character(seen$allow_jgd),",
        "  as.character(file.exists(marker)), tool_path), result)"
    ), runner)

    read_child_logs <- function(logs, timeout_seconds = 10) {
        deadline <- Sys.time() + timeout_seconds
        repeat {
            output <- lapply(logs, function(path) {
                suppressWarnings(tryCatch(readLines(path, warn = FALSE),
                                          error = function(error) error))
            })
            failed <- vapply(output, inherits, FALSE, "error")
            if (!any(failed)) return(unlist(output))
            if (Sys.time() >= deadline) {
                stop(output[[which(failed)[[1L]]]])
            }
            # Publishing a result does not close redirected stdout/stderr. Windows
            # can deny read access until the asynchronous child releases them.
            Sys.sleep(0.02)
        }
    }

    # Answer consent requests by package until the child publishes its result.
    serve <- function(consent, result, answers, logs) {
        seen <- list()
        handled <- character()
        deadline <- Sys.time() + 90
        repeat {
            for (path in list.files(consent, pattern = "\\.request$", full.names = TRUE)) {
                id <- sub("\\.request$", "", basename(path))
                if (id %in% handled) next
                handled <- c(handled, id)
                lines <- readLines(path, warn = FALSE)
                seen[[length(seen) + 1L]] <- lines
                answer <- answers[[lines[[6L]]]]
                if (is.null(answer)) answer <- "decline"
                temporary <- file.path(consent, paste0(id, ".response.tmp"))
                writeLines(answer, temporary, useBytes = TRUE)
                stopifnot(file.rename(temporary, file.path(consent, paste0(id, ".response"))))
            }
            if (file.exists(result)) return(seen)
            if (Sys.time() >= deadline) {
                output <- tryCatch(read_child_logs(logs, timeout_seconds = 0),
                                   error = conditionMessage)
                stop("Timed out waiting for the attach child: ", paste(output, collapse = "\n"))
            }
            Sys.sleep(0.02)
        }
    }

    run_mode <- function(mode, answers = list()) {
        result <- file.path(root, paste0(mode, "-result"))
        logs <- file.path(root, paste0(mode, c("-out", "-err")))
        dir.create(file.path(root, mode), showWarnings = FALSE)
        args <- c("--vanilla", "--slave", paste0("--file=", runner), "--args",
                  mode, root, repo, result, fixtures)
        system2_with_child_environment(isolated_child_env(mode), r_binary, shQuote(args),
                                       wait = FALSE, stdout = logs[[1L]], stderr = logs[[2L]])
        requests <- serve(file.path(root, mode, "consent"), result, answers, logs)
        output <- read_child_logs(logs)
        list(values = readLines(result, warn = FALSE), requests = requests,
             messages = grep("^vscode-R|incompatible", output, value = TRUE))
    }
    request_summary <- function(request) request[c(4L, 6L, 7L)]

    approved <- run_mode("approved", list(rstudioapi = "approve"))
    tool_package <- file.path(approved$values[[8L]], "rstudioapi")
    stopifnot(length(approved$requests) == 1L,
              identical(request_summary(approved$requests[[1L]]),
                        c("once", "rstudioapi", minimum_version)),
              identical(approved$values[1:7],
                        c("TRUE", normalizePath(tool_package, winslash = "/"), minimum_version,
                          "TRUE", "FALSE", "TRUE", "TRUE")),
              length(approved$messages) == 0L)

    declined <- run_mode("declined")
    stopifnot(length(declined$requests) == 1L,
              identical(declined$values[c(1L, 4L, 7L)], c("FALSE", "FALSE", "TRUE")),
              length(declined$messages) == 1L,
              grepl("rstudioapi installation was not approved", declined$messages))
    stopifnot(!dir.exists(file.path(declined$values[[8L]], "rstudioapi")))

    offline <- run_mode("offline")
    stopifnot(length(offline$requests) == 0L,
              identical(offline$values[c(1L, 4L)], c("FALSE", "FALSE")),
              length(offline$messages) == 1L,
              grepl("could not prepare optional rstudioapi support", offline$messages))

    # Emulation disabled: no request, no repository query, no message.
    disabled <- run_mode("disabled", list(rstudioapi = "approve"))
    stopifnot(length(disabled$requests) == 0L,
              identical(disabled$values[c(1L, 4L, 7L)], c("FALSE", "FALSE", "FALSE")),
              length(disabled$messages) == 0L)

    # Without a prompt only an existing compatible copy is used, silently and
    # without contacting repositories.
    no_prompt <- run_mode("no-prompt")
    stopifnot(length(no_prompt$requests) == 0L,
              identical(no_prompt$values[c(1L, 4L, 7L)], c("FALSE", "FALSE", "FALSE")),
              length(no_prompt$messages) == 0L)
    compatible <- run_mode("no-prompt-compatible")
    stopifnot(length(compatible$requests) == 0L,
              identical(compatible$values[c(1L, 3L, 4L, 7L)], c("TRUE", minimum_version, "TRUE", "FALSE")),
              grepl("/ordinary-library/rstudioapi$", compatible$values[[2L]]))

    # A loaded namespace is never replaced, whatever its version.
    loaded <- run_mode("loaded-compatible")
    stopifnot(length(loaded$requests) == 0L,
              identical(loaded$values[c(1L, 3L, 7L)], c("TRUE", minimum_version, "FALSE")),
              grepl("/ordinary-library/rstudioapi$", loaded$values[[2L]]))
    old <- run_mode("loaded-incompatible", list(rstudioapi = "approve"))
    stopifnot(length(old$requests) == 0L,
              identical(old$values[c(1L, 3L, 7L)], c("TRUE", "0.3.1", "FALSE")),
              grepl("/old-library/rstudioapi$", old$values[[2L]]),
              length(old$messages) == 1L)

    # jgd and rstudioapi in the same startup: two separate requests, each
    # with its own policy, and the decision for one does not affect the other.
    both <- run_mode("both", list(rstudioapi = "approve", jgd = "decline"))
    summaries <- vapply(both$requests, function(request) paste(request_summary(request), collapse = " "), "")
    stopifnot(identical(sort(summaries), sort(c("once rstudioapi 0.4.0", "once jgd 0.1.0"))),
              identical(both$values[c(1L, 4L, 5L, 6L)], c("TRUE", "TRUE", "FALSE", "FALSE")))
    explicit <- run_mode("both-explicit", list(rstudioapi = "approve", jgd = "approve"))
    summaries <- vapply(explicit$requests, function(request) paste(request_summary(request), collapse = " "), "")
    stopifnot(identical(sort(summaries), sort(c("once rstudioapi 0.4.0", "always jgd 0.1.0"))),
              identical(explicit$values[c(1L, 4L, 5L, 6L)], c("TRUE", "TRUE", "TRUE", "TRUE")))

    # Terminal startup profile: emulation setting drives preparation.
    profile_run <- function(label, emulation, answer) {
        profile_root <- file.path(root, label)
        dir.create(profile_root)
        consent <- file.path(profile_root, "consent")
        dir.create(consent)
        connect_log <- file.path(profile_root, "connect-log")
        stub_attach <- file.path(profile_root, "attach-helper.R")
        placeholder <- file.path(profile_root, "placeholder.R")
        file.create(placeholder)
        writeLines(c(
            "source(file.path(getwd(), 'R', 'attach_sess.R'))",
            "vscode_r_prepare_sess <- function(...) {",
            "  ns <- new.env(); ns$connect <- function(use_rstudioapi=TRUE, ...) {",
            paste0("  writeLines(c(as.character(use_rstudioapi), as.character('rstudioapi' %in% loadedNamespaces())), ",
                   r_literal(connect_log), ")"),
            "  TRUE",
            "}; ns }"
        ), stub_attach)
        startup <- file.path(profile_root, "run-profile.R")
        writeLines(c(
            paste0("Sys.setenv(VSCODE_R_SESS_PKG_PATH=", r_literal(profile_root), ","),
            paste0("  VSCODE_R_SESS_SOURCE_HELPER=", r_literal(placeholder), ","),
            paste0("  VSCODE_R_SESS_ATTACH_HELPER=", r_literal(stub_attach), ","),
            paste0("  VSCODE_R_SESS_INSTALLER_HELPER=", r_literal(placeholder), ","),
            paste0("  VSCODE_R_SESS_ROOT=", r_literal(profile_root), ","),
            paste0("  VSCODE_R_SESS_CONSENT_DIRECTORY=", r_literal(consent), ","),
            paste0("  VSCODE_R_TOOL_PREPARE_HELPER=", r_literal(file.path(getwd(), "R", "prepare-tools.R")), ","),
            paste0("  VSCODE_R_TOOL_ROOT=", r_literal(file.path(profile_root, "tools")), ","),
            paste0("  VSCODE_R_TOOL_CONSENT_DIRECTORY=", r_literal(consent), ","),
            paste0("  VSCODE_R_TOOL_LIBRARY_HELPER=", r_literal(file.path(getwd(), "R", "tool-library.R")), ","),
            paste0("  VSCODE_R_TOOL_CONSENT_HELPER=", r_literal(file.path(getwd(), "R", "tool-consent.R")), ","),
            paste0("  VSCODE_R_RSTUDIOAPI_MINIMUM_VERSION=", r_literal(minimum_version), ","),
            "  VSCODE_R_RSTUDIOAPI_CAN_PROMPT='TRUE',",
            paste0("  R_PROFILE_USER_OLD=", r_literal(placeholder), ","),
            paste0("  SESS_PLOT_BACKEND='standard', SESS_RSTUDIOAPI='", emulation, "')"),
            paste0("options(repos=c(CRAN=", r_literal(repo), "), pkgType='source')"),
            "source(file.path(getwd(), 'R', 'profile.R'))"
        ), startup)
        logs <- file.path(profile_root, c("stdout", "stderr"))
        system2_with_child_environment(isolated_child_env(label), r_binary,
                                       shQuote(c("--vanilla", "--slave", paste0("--file=", startup))),
                                       wait = FALSE, stdout = logs[[1L]], stderr = logs[[2L]])
        requests <- serve(consent, connect_log, list(rstudioapi = answer), logs)
        list(values = readLines(connect_log, warn = FALSE), requests = requests)
    }
    enabled <- profile_run("profile-enabled", "TRUE", "approve")
    stopifnot(length(enabled$requests) == 1L,
              identical(request_summary(enabled$requests[[1L]]), c("once", "rstudioapi", minimum_version)),
              identical(enabled$values, c("TRUE", "TRUE")))
    suppressed <- profile_run("profile-disabled", "FALSE", "approve")
    stopifnot(length(suppressed$requests) == 0L, identical(suppressed$values, c("FALSE", "FALSE")))

    cat("rstudioapi preparation integration tests passed\n")
})
