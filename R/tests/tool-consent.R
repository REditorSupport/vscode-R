# Base-R tests for the shared, plan-bound tool installation consent file.
source("R/tool-library.R")
source("R/tool-consent.R")

local({
    root <- tempfile("tool-consent-")
    dir.create(root)
    root <- normalizePath(root, winslash = "/", mustWork = TRUE)
    on.exit(unlink(root, recursive = TRUE), add = TRUE)
    library <- tool_library_path(root)
    repository <- "https://example.invalid/src/contrib"
    available <- matrix(
        c("jgd", "0.1.0", "", "yes", repository),
        nrow = 1L,
        dimnames = list("jgd", c("Package", "Version", "Imports", "NeedsCompilation", "Repository"))
    )
    plan <- structure(
        list(
            package = "jgd",
            minimum_version = "0.1.0",
            version = "0.1.0",
            repository = repository,
            package_type = "source",
            source_build = TRUE,
            repositories = "https://example.invalid",
            available = available,
            root = root,
            library = library
        ),
        class = "vscode_r_tool_install_plan"
    )

    lines <- .tool_consent_lines(plan, strrep("a", 32L), "jgd")
    stopifnot(length(lines) == 11L)
    stopifnot(identical(lines[c(1L, 2L, 4L, 5L)],
                        c("vscode-r-package-consent-v1", strrep("a", 32L), "jgd", "1")))
    stopifnot(identical(lines[6:11],
                        c("jgd", "0.1.0", "0.1.0", repository, "source", "yes")))
    invalid <- plan
    invalid$repository <- paste0(repository, "\nother.example")
    stopifnot(inherits(tryCatch(.tool_consent_lines(invalid, strrep("b", 32L), "auto"),
                                error = identity), "error"))

    directory <- file.path(root, "consent")
    dir.create(directory)
    approval <- .tool_publish_consent_request(plan, strrep("c", 32L), "auto", directory)
    stopifnot(identical(readLines(approval$request_path),
                        .tool_consent_lines(plan, strrep("c", 32L), "auto")))
    stopifnot(inherits(tryCatch(.tool_publish_consent_request(plan, strrep("c", 32L),
                                                              "auto", directory),
                                error = identity), "error"))
    writeLines("approve", approval$response_path)
    stopifnot(isTRUE(.tool_wait_for_consent(approval, timeout_seconds = 0)))
    stopifnot(!file.exists(approval$request_path), !file.exists(approval$response_path))

    changed <- .tool_publish_consent_request(plan, strrep("d", 32L), "auto", directory)
    changed_lines <- changed$lines
    changed_lines[8L] <- "0.2.0"
    writeLines(changed_lines, changed$request_path)
    writeLines("approve", changed$response_path)
    stopifnot(!.tool_wait_for_consent(changed, timeout_seconds = 0))
    stopifnot(!file.exists(changed$request_path), !file.exists(changed$response_path))

    declined <- .tool_publish_consent_request(plan, strrep("e", 32L), "jgd", directory)
    writeLines("decline", declined$response_path)
    stopifnot(!.tool_wait_for_consent(declined, timeout_seconds = 0))
    stopifnot(!file.exists(declined$request_path), !file.exists(declined$response_path))

    stopifnot(!.tool_request_consent(plan, "auto", directory, timeout_seconds = 0))
    stopifnot(length(list.files(directory)) == 0L)

    unavailable <- .tool_publish_consent_request(plan, strrep("f", 32L), "auto", directory)
    stopifnot(!.tool_wait_for_consent(unavailable, timeout_seconds = 0))
    stopifnot(!file.exists(unavailable$request_path), !file.exists(unavailable$response_path))
    invalid_timeout <- .tool_publish_consent_request(plan, strrep("0", 32L), "auto", directory)
    stopifnot(inherits(tryCatch(.tool_wait_for_consent(invalid_timeout, timeout_seconds = -1),
                                error = identity), "error"))
    stopifnot(!file.exists(invalid_timeout$request_path), !file.exists(invalid_timeout$response_path))

    prompt_calls <- 0L
    install_calls <- 0L
    permission <- FALSE
    ready <- FALSE
    prepare_environment <- new.env(parent = environment(tool_library_prepare))
    prepare_environment$tool_library_check <- function(...) {
        list(package = "jgd", version = if (ready) "1.0.0" else NULL,
             source = if (ready) "managed" else "install",
             install_required = !ready, library = library)
    }
    prepare_environment$tool_library_plan <- function(...) if (ready) NULL else plan
    prepare_environment$.tool_request_consent <- function(received, backend, directory,
                                                          timeout_seconds) {
        prompt_calls <<- prompt_calls + 1L
        stopifnot(identical(received, plan), backend %in% c("jgd", "auto"),
                  identical(directory, "consent"))
        permission
    }
    prepare_environment$tool_library_install <- function(package, minimum_version, root,
                                                         repos, timeout_seconds, plan) {
        install_calls <<- install_calls + 1L
        stopifnot(identical(plan, received_plan), identical(repos, plan$repositories))
        list(package = package, version = plan$version, source = "managed",
             install_required = FALSE, library = plan$library)
    }
    received_plan <- plan
    prepare <- tool_library_prepare
    environment(prepare) <- prepare_environment
    stopifnot(is.null(prepare("jgd", "0.1.0", root, "consent", "auto", repos = character())))
    stopifnot(prompt_calls == 1L, install_calls == 0L)
    permission <- FALSE
    stopifnot(is.null(prepare("jgd", "0.1.0", root, "consent", "jgd", repos = character())))
    stopifnot(prompt_calls == 2L, install_calls == 0L)
    permission <- TRUE
    prepare("jgd", "0.1.0", root, "consent", "auto", repos = character())
    stopifnot(prompt_calls == 3L, install_calls == 1L)
    ready <- TRUE
    prepare("jgd", "0.1.0", root, "consent", "auto", repos = character())
    stopifnot(prompt_calls == 3L, install_calls == 1L)

    # Exercise prepare through its real file request and response path.
    ready <- FALSE
    consent_directory <- file.path(root, "prepare consent")
    dir.create(consent_directory)
    original_wait <- .tool_wait_for_consent
    prepare_environment$.tool_request_consent <- function(received, backend,
                                                          directory, timeout_seconds) {
        request <- .tool_publish_consent_request(received, strrep("1", 32L),
                                                 backend, directory)
        prepare_environment$.tool_wait_for_consent(request, timeout_seconds)
    }
    prepare_environment$.tool_wait_for_consent <- function(request, timeout_seconds) {
        writeLines("approve", request$response_path)
        original_wait(request, timeout_seconds = 0)
    }
    prepared <- prepare("jgd", "0.1.0", root, consent_directory, "jgd",
                        repos = character())
    stopifnot(identical(prepared$version, plan$version),
              prompt_calls == 3L, install_calls == 2L,
              length(list.files(consent_directory)) == 0L)

    cat("managed tool consent tests passed\n")
})
