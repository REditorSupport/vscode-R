# Keep optional jgd preparation and its result shared by terminal connections.
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
    if (!plot_backend %in% c("jgd", "auto")) {
        return(connect(allow_jgd = TRUE))
    }
    ready <- isTRUE(vscode_r_prepare_jgd(
        plot_backend, tool_root, consent_directory,
        library_helper, consent_helper, can_prompt, minimum_version
    ))
    connect(allow_jgd = ready)
}

# Select, install if approved, and eagerly load one tool package. Returns TRUE
# when a compatible copy is loaded, otherwise prints a short message and
# returns FALSE so the caller can continue with its fallback. `policy` is the
# consent policy sent to the extension ("always" or "once"); `fallback` and
# `support` only word the messages. An already loaded namespace is never replaced.
vscode_r_prepare_tool_package <- function(
    package,
    policy,
    tool_root,
    consent_directory,
    library_helper,
    consent_helper,
    can_prompt,
    minimum_version,
    support,
    fallback,
    report_load_failure = TRUE
) {
    if (!(is.logical(can_prompt) && length(can_prompt) == 1L && !is.na(can_prompt))) {
        stop("can_prompt must be a single non-NA logical value.", call. = FALSE)
    }
    helpers <- c(library_helper, consent_helper)
    if (any(!nzchar(helpers)) || any(!file.exists(helpers)) || !nzchar(tool_root)) {
        message("vscode-R could not locate managed ", package, " setup resources; ", fallback, ".")
        return(FALSE)
    }

    tryCatch({
        tool_environment <- new.env(parent = environment(vscode_r_prepare_tool_package))
        for (helper in helpers) {
            sys.source(helper, envir = tool_environment)
        }
        if (!can_prompt) {
            # A compatible ordinary or managed copy remains usable without resolving a new plan.
            return(!is.null(tool_environment$tool_library_load(
                package, minimum_version, tool_root
            )))
        }
        prepared <- tool_environment$tool_library_prepare(
            package,
            minimum_version,
            tool_root,
            consent_directory,
            policy,
            consent_timeout_seconds = 180,
            install_timeout_seconds = 300,
            resolution_timeout_seconds = 30
        )
        if (is.null(prepared)) {
            message("vscode-R optional ", package, " installation was not approved; ", fallback, ".")
            return(FALSE)
        }
        namespace <- tool_environment$tool_library_load(
            package, minimum_version, tool_root
        )
        if (is.null(namespace)) {
            if (report_load_failure) {
                message("vscode-R could not load a compatible ", package, " package; ", fallback, ".")
            }
            return(FALSE)
        }
        TRUE
    }, error = function(error) {
        message("vscode-R could not prepare optional ", support, ": ", conditionMessage(error))
        FALSE
    }, interrupt = function(error) {
        message("vscode-R ", package, " preparation was interrupted; ", fallback, ".")
        FALSE
    })
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
    # An explicit jgd backend is offered installation on every request; auto only once.
    vscode_r_prepare_tool_package(
        "jgd",
        if (identical(plot_backend, "jgd")) "always" else "once",
        tool_root, consent_directory, library_helper, consent_helper,
        can_prompt, minimum_version,
        support = "jgd plot support",
        fallback = "using the available plot fallback"
    )
}

# Make rstudioapi available before sess starts its emulation, so that
# requireNamespace("rstudioapi") succeeds even in isolated project libraries.
# Emulation stays enabled whatever the outcome: sess patches rstudioapi when it
# is loaded now or later. Does nothing when emulation is disabled.
vscode_r_prepare_rstudioapi <- function(
    use_rstudioapi,
    tool_root = Sys.getenv("VSCODE_R_TOOL_ROOT", unset = ""),
    consent_directory = Sys.getenv("VSCODE_R_TOOL_CONSENT_DIRECTORY", unset = ""),
    library_helper = Sys.getenv("VSCODE_R_TOOL_LIBRARY_HELPER", unset = ""),
    consent_helper = Sys.getenv("VSCODE_R_TOOL_CONSENT_HELPER", unset = ""),
    can_prompt = identical(Sys.getenv("VSCODE_R_RSTUDIOAPI_CAN_PROMPT", unset = "TRUE"), "TRUE"),
    minimum_version = Sys.getenv("VSCODE_R_RSTUDIOAPI_MINIMUM_VERSION", unset = "")
) {
    # sess treats an unset (NA) value as enabled.
    if (identical(use_rstudioapi, FALSE)) {
        return(FALSE)
    }
    vscode_r_prepare_tool_package(
        "rstudioapi", "once",
        tool_root, consent_directory, library_helper, consent_helper,
        can_prompt, minimum_version,
        support = "rstudioapi support",
        fallback = "continuing without it",
        # An incompatible loaded namespace is already reported by the loader.
        report_load_failure = FALSE
    )
}
