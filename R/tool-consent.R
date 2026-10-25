# File-based consent for optional packages managed by vscode-R.
.tool_consent_max_bytes <- 16384L
.tool_consent_request_version <- "vscode-r-package-consent-v1"

.tool_consent_lines <- function(plan, id, backend) {
    if (!inherits(plan, "vscode_r_tool_install_plan") ||
            !(is.character(id) && length(id) == 1L &&
                  grepl("^[A-Za-z0-9_-]{1,64}$", id)) ||
            !(is.character(backend) && length(backend) == 1L && backend %in% c("jgd", "auto"))) {
        stop("Invalid managed tool consent request.", call. = FALSE)
    }
    .tool_validate_install_plan(plan, plan$package, plan$minimum_version, plan$root)
    runtime_minor <- strsplit(R.version$minor, ".", fixed = TRUE)[[1L]][1L]
    runtime <- paste(R.version$platform,
                     paste(R.version$major, runtime_minor, sep = "."), sep = "|")
    package_fields <- c(plan$package, plan$minimum_version, plan$version,
                        plan$repository, plan$package_type,
                        if (isTRUE(plan$source_build)) "yes" else "no")
    if (anyNA(package_fields) || any(!nzchar(package_fields)) ||
            any(grepl("[\r\n]", package_fields))) {
        stop("The managed tool installation plan cannot be represented in a consent request.",
             call. = FALSE)
    }
    lines <- c(.tool_consent_request_version, id, runtime, backend, "1", package_fields)
    request <- paste0(paste(lines, collapse = "\n"), "\n")
    if (nchar(request, type = "bytes") > .tool_consent_max_bytes) {
        stop("The managed tool consent request is too large.", call. = FALSE)
    }
    lines
}

.tool_publish_consent_request <- function(plan, id, backend, directory) {
    if (!(is.character(directory) && length(directory) == 1L &&
              !is.na(directory) && nzchar(directory))) {
        stop("The managed tool consent directory is unavailable.", call. = FALSE)
    }
    dir.create(directory, recursive = TRUE, showWarnings = FALSE, mode = "0700")
    if (!dir.exists(directory) || file.access(directory, 2L) != 0L) {
        stop("The managed tool consent directory is unavailable.", call. = FALSE)
    }
    if (.Platform$OS.type == "unix") Sys.chmod(directory, "0700")
    lines <- .tool_consent_lines(plan, id, backend)
    request_path <- file.path(directory, paste0(id, ".request"))
    response_path <- file.path(directory, paste0(id, ".response"))
    if (file.exists(request_path) || file.exists(response_path)) {
        stop("The managed tool consent request ID has already been used.", call. = FALSE)
    }
    temporary_path <- tempfile(pattern = paste0(id, "-"), tmpdir = directory)
    on.exit(unlink(temporary_path), add = TRUE)
    writeLines(lines, temporary_path, useBytes = TRUE)
    if (.Platform$OS.type == "unix") Sys.chmod(temporary_path, "0600")
    if (!file.rename(temporary_path, request_path)) {
        stop("Could not publish the managed tool consent request.", call. = FALSE)
    }
    if (.Platform$OS.type == "unix") Sys.chmod(request_path, "0600")
    list(id = id, lines = lines, request_path = request_path,
         response_path = response_path)
}

.tool_wait_for_consent <- function(request, timeout_seconds = 180) {
    directory <- dirname(request$request_path)
    on.exit(unlink(c(request$request_path, request$response_path)), add = TRUE)
    if (!(is.numeric(timeout_seconds) && length(timeout_seconds) == 1L &&
              !is.na(timeout_seconds) && is.finite(timeout_seconds) && timeout_seconds >= 0)) {
        stop("timeout_seconds must be a finite non-negative number.", call. = FALSE)
    }
    deadline <- Sys.time() + timeout_seconds
    repeat {
        if (!dir.exists(directory) || !file.exists(request$request_path)) return(FALSE)
        request_size <- file.info(request$request_path)$size
        if (is.na(request_size) || request_size > .tool_consent_max_bytes) return(FALSE)
        request_lines <- tryCatch(readLines(request$request_path, warn = FALSE),
                                  error = function(error) character())
        # A grant applies to the exact version and source the user saw.
        if (!identical(request_lines, request$lines)) return(FALSE)
        if (file.exists(request$response_path)) {
            response_size <- file.info(request$response_path)$size
            if (is.na(response_size) || response_size > 32L) {
                stop("Invalid response to the managed tool consent request.", call. = FALSE)
            }
            response <- tryCatch(readLines(request$response_path, warn = FALSE),
                                 error = function(error) character())
            if (identical(response, "approve")) return(TRUE)
            if (identical(response, "decline")) return(FALSE)
            stop("Invalid response to the managed tool consent request.", call. = FALSE)
        }
        if (Sys.time() >= deadline) return(FALSE)
        Sys.sleep(0.1)
    }
}

.tool_request_consent <- function(plan, backend, directory, timeout_seconds = 180) {
    if (!(is.character(directory) && length(directory) == 1L &&
              !is.na(directory) && nzchar(directory) && dir.exists(directory))) {
        stop("The extension's tool consent service is unavailable. Restart VS Code and try again.",
             call. = FALSE)
    }
    repeat {
        temporary <- paste0(
            basename(tempfile(pattern = "request-", tmpdir = directory)),
            basename(tempfile(pattern = "request-", tmpdir = directory))
        )
        id <- gsub("[^A-Za-z0-9_-]", "",
                   sub("^request-", "", sub("^request-", "", temporary)))
        if (!grepl("^[A-Za-z0-9_-]{16,64}$", id)) next
        request_path <- file.path(directory, paste0(id, ".request"))
        response_path <- file.path(directory, paste0(id, ".response"))
        if (!file.exists(request_path) && !file.exists(response_path)) break
    }
    request <- .tool_publish_consent_request(plan, id, backend, directory)
    .tool_wait_for_consent(request, timeout_seconds)
}

# Request consent only when no compatible namespace is already available.
# On approval the frozen repository result is passed directly to installation.
tool_library_prepare <- function(package, minimum_version, root, consent_directory,
                                 backend, repos = getOption("repos"),
                                 consent_timeout_seconds = 180,
                                 install_timeout_seconds = 300) {
    available <- tool_library_check(package, minimum_version, root)
    if (!available$install_required) return(invisible(available))
    plan <- tool_library_plan(package, minimum_version, root, repos)
    if (is.null(plan)) return(invisible(tool_library_check(package, minimum_version, root)))
    approved <- .tool_request_consent(plan, backend, consent_directory,
                                      timeout_seconds = consent_timeout_seconds)
    if (!isTRUE(approved)) return(invisible(NULL))
    tool_library_install(package, minimum_version, root, repos = plan$repositories,
                         timeout_seconds = install_timeout_seconds, plan = plan)
}
