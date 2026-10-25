# Keep socket fallback, preparation, connection, and restoration in one place.
vscode_r_connect_with_jgd <- function(
    plot_backend,
    connect,
    tool_root = Sys.getenv("VSCODE_R_TOOL_ROOT", unset = ""),
    consent_directory = Sys.getenv("VSCODE_R_TOOL_CONSENT_DIRECTORY", unset = ""),
    library_helper = Sys.getenv("VSCODE_R_TOOL_LIBRARY_HELPER", unset = ""),
    consent_helper = Sys.getenv("VSCODE_R_TOOL_CONSENT_HELPER", unset = ""),
    can_prompt = identical(Sys.getenv("VSCODE_R_JGD_CAN_PROMPT", unset = "TRUE"), "TRUE"),
    minimum_version = Sys.getenv("VSCODE_R_JGD_MINIMUM_VERSION", unset = "")
) {
    if (!is.function(connect)) stop("connect must be a function.", call. = FALSE)
    if (!plot_backend %in% c("jgd", "auto") || !nzchar(Sys.getenv("JGD_SOCKET", unset = ""))) {
        return(connect())
    }
    previous_socket <- Sys.getenv("JGD_SOCKET", unset = NA_character_)
    on.exit({
        if (is.na(previous_socket)) {
            Sys.unsetenv("JGD_SOCKET")
        } else {
            Sys.setenv(JGD_SOCKET = previous_socket)
        }
    }, add = TRUE)
    ready <- isTRUE(vscode_r_prepare_jgd(
        plot_backend, tool_root, consent_directory,
        library_helper, consent_helper, can_prompt, minimum_version
    ))
    if (!ready) {
        # An old loaded jgd namespace still satisfies requireNamespace; hide the socket so hooks choose fallback.
        Sys.unsetenv("JGD_SOCKET")
    }
    connect()
}

# Prepare optional plot support without making sess startup depend on CRAN access
# or user consent. The managed library is loaded before sess checks the package.
vscode_r_prepare_jgd <- function(
    plot_backend,
    tool_root = Sys.getenv("VSCODE_R_TOOL_ROOT", unset = ""),
    consent_directory = Sys.getenv("VSCODE_R_TOOL_CONSENT_DIRECTORY", unset = ""),
    library_helper = Sys.getenv("VSCODE_R_TOOL_LIBRARY_HELPER", unset = ""),
    consent_helper = Sys.getenv("VSCODE_R_TOOL_CONSENT_HELPER", unset = ""),
    can_prompt = identical(Sys.getenv("VSCODE_R_JGD_CAN_PROMPT", unset = "TRUE"), "TRUE"),
    minimum_version = Sys.getenv("VSCODE_R_JGD_MINIMUM_VERSION", unset = "")
) {
    if (!is.character(plot_backend) || length(plot_backend) != 1L ||
            is.na(plot_backend) || !plot_backend %in% c("jgd", "auto")) {
        return(FALSE)
    }
    if (!nzchar(Sys.getenv("JGD_SOCKET", unset = ""))) {
        return(FALSE)
    }
    if (!(is.logical(can_prompt) && length(can_prompt) == 1L && !is.na(can_prompt))) {
        stop("can_prompt must be a single non-NA logical value.", call. = FALSE)
    }
    helpers <- c(library_helper, consent_helper)
    if (any(!nzchar(helpers)) || any(!file.exists(helpers)) || !nzchar(tool_root)) {
        message("vscode-R could not locate managed jgd setup resources; using the available plot fallback.")
        return(FALSE)
    }

    tryCatch({
        tool_environment <- new.env(parent = environment(vscode_r_prepare_jgd))
        for (helper in helpers) {
            sys.source(helper, envir = tool_environment)
        }
        if (!can_prompt) {
            # A compatible ordinary or managed copy remains usable without resolving a new plan.
            return(!is.null(tool_environment$tool_library_load(
                "jgd", minimum_version, tool_root
            )))
        }
        prepared <- tool_environment$tool_library_prepare(
            "jgd",
            minimum_version,
            tool_root,
            consent_directory,
            plot_backend,
            consent_timeout_seconds = 180,
            install_timeout_seconds = 300,
            resolution_timeout_seconds = 30
        )
        if (is.null(prepared)) {
            message("vscode-R optional jgd installation was not approved; using the available plot fallback.")
            return(FALSE)
        }
        namespace <- tool_environment$tool_library_load(
            "jgd", minimum_version, tool_root
        )
        if (is.null(namespace)) {
            message("vscode-R could not load a compatible jgd package; using the available plot fallback.")
            return(FALSE)
        }
        TRUE
    }, error = function(error) {
        message("vscode-R could not prepare optional jgd plot support: ", conditionMessage(error))
        FALSE
    }, interrupt = function(error) {
        message("vscode-R jgd preparation was interrupted; using the available plot fallback.")
        FALSE
    })
}
