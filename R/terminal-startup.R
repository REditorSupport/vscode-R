# Base-R-only notification for one managed terminal startup attempt.
# Keep the wire format in sync with src/terminalStartup.ts: protocol, terminal
# token, attempt ID, originating R PID, endpoint, and state.
.vscode_startup_option <- "vscodeR.terminalStartup"
.vscode_startup_protocol <- "vscode-r-terminal-startup-v1"

.vscode_startup_valid <- function(file, token) {
    length(file) == 1L && !is.na(file) && nzchar(file) &&
        length(token) == 1L && !is.na(token) && grepl("^[[:xdigit:]]{32}$", token)
}

.vscode_startup_valid_endpoint <- function(endpoint) {
    length(endpoint) == 1L && !is.na(endpoint) && nzchar(endpoint) &&
        !grepl("[\r\n]", endpoint)
}

.vscode_startup_registered <- function(context) {
    registered <- getOption(.vscode_startup_option)
    is.list(registered) && is.list(context) &&
        identical(registered$file, context$file) &&
        identical(registered$token, context$token) &&
        identical(registered$pid, Sys.getpid()) &&
        identical(context$pid, Sys.getpid()) &&
        is.function(registered$run) && identical(registered$run, context$run) &&
        .vscode_startup_valid_endpoint(context$endpoint)
}

.vscode_startup_write <- function(context, attempt, state) {
    lines <- c(.vscode_startup_protocol, context$token, attempt,
               as.character(context$pid), context$endpoint, state)
    temporary <- ""
    on.exit(if (nzchar(temporary)) unlink(temporary), add = TRUE)
    tryCatch(suppressWarnings({
        directory <- dirname(context$file)
        if (!dir.exists(directory)) {
            return(FALSE)
        }
        temporary <- tempfile(pattern = ".startup-", tmpdir = directory)
        writeLines(lines, temporary, useBytes = TRUE)
        if (.Platform$OS.type == "unix") {
            Sys.chmod(temporary, "0600")
        }
        isTRUE(file.rename(temporary, context$file))
    }), error = function(error) FALSE)
}

# Called only by the managed terminal profile. The option is process-local so
# inherited environment variables cannot authorize a child R to update a parent.
vscode_r_startup_register <- function(file, token, endpoint) {
    if (!.vscode_startup_valid(file, token) || !.vscode_startup_valid_endpoint(endpoint)) {
        return(NULL)
    }
    context <- list(
        file = file,
        token = tolower(token),
        endpoint = endpoint,
        pid = Sys.getpid(),
        attempt = NULL
    )
    context$run <- function(endpoint, setup) {
        current <- vscode_r_startup_existing(endpoint)
        if (is.null(current)) {
            return(invisible(FALSE))
        }
        vscode_r_startup_run(current, setup)
    }
    options(structure(list(context), names = .vscode_startup_option))
    context
}

# Manual attach reuses the immutable profile identity while recording its current
# endpoint for this attempt. The endpoint may differ after a reconnect.
vscode_r_startup_existing <- function(endpoint) {
    if (!.vscode_startup_valid_endpoint(endpoint)) {
        return(NULL)
    }
    registered <- getOption(.vscode_startup_option)
    if (!is.list(registered)) {
        return(NULL)
    }
    if (!.vscode_startup_valid(registered$file, registered$token)) {
        return(NULL)
    }
    if (!identical(registered$pid, Sys.getpid())) {
        return(NULL)
    }
    if (!is.function(registered$run)) {
        return(NULL)
    }
    registered$endpoint <- endpoint
    registered
}

# Publish pending before doing any package preparation or IPC work. A failed
# publish returns NULL, leaving callers free to keep ordinary R usable.
vscode_r_startup_begin <- function(context) {
    if (!.vscode_startup_registered(context)) {
        return(NULL)
    }
    candidate <- gsub("[^A-Za-z0-9_-]", "", basename(tempfile(pattern = "attempt-")))
    candidate <- paste0(candidate, substr(context$token, 1L, 16L))
    attempt <- substr(candidate, 1L, 64L)
    if (!grepl("^[A-Za-z0-9_-]{16,64}$", attempt)) {
        message("vscode-R could not create a terminal startup attempt ID.")
        return(NULL)
    }
    if (!.vscode_startup_write(context, attempt, "pending")) {
        message("vscode-R could not publish terminal startup status; the session watcher was not started.")
        return(NULL)
    }
    context$attempt <- attempt
    options(structure(list(context), names = .vscode_startup_option))
    attempt
}

# A completion can update only the attempt currently registered in this process.
# If atomic publication fails, the last successfully published pending status remains.
vscode_r_startup_finish <- function(context, attempt, state) {
    if (!state %in% c("ready", "failed")) {
        return(invisible(FALSE))
    }
    if (!.vscode_startup_registered(context)) {
        return(invisible(FALSE))
    }
    registered <- getOption(.vscode_startup_option)
    if (!identical(registered$attempt, attempt)) {
        return(invisible(FALSE))
    }
    if (!identical(registered$endpoint, context$endpoint)) {
        return(invisible(FALSE))
    }
    if (!.vscode_startup_write(context, attempt, state)) {
        message("vscode-R could not publish terminal startup completion; status remains pending.")
        return(invisible(FALSE))
    }
    invisible(TRUE)
}

# Wrap one setup attempt for both the profile and generated manual attach.
# Without a matching profile registration, setup keeps its historical behavior.
vscode_r_startup_run <- function(context, setup) {
    if (is.null(context)) {
        return(setup())
    }
    attempt <- vscode_r_startup_begin(context)
    if (is.null(attempt)) {
        return(invisible(FALSE))
    }
    completed <- FALSE
    on.exit({
        vscode_r_startup_finish(context, attempt, if (completed) "ready" else "failed")
    }, add = TRUE)
    result <- setup()
    completed <- isTRUE(result)
    result
}
