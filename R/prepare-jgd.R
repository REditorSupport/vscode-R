# Keep the jgd minimum in one R-side location so consent and installation agree.
VSCODE_R_JGD_MINIMUM_VERSION <- "0.1.0"

# Prepare optional plot support without making sess startup depend on CRAN access
# or user consent. The managed library is loaded before sess checks the package.
vscode_r_prepare_jgd <- function(
    plot_backend,
    tool_root = Sys.getenv("VSCODE_R_TOOL_ROOT", unset = ""),
    consent_directory = Sys.getenv("VSCODE_R_TOOL_CONSENT_DIRECTORY", unset = ""),
    library_helper = Sys.getenv("VSCODE_R_TOOL_LIBRARY_HELPER", unset = ""),
    consent_helper = Sys.getenv("VSCODE_R_TOOL_CONSENT_HELPER", unset = "")
) {
    if (!is.character(plot_backend) || length(plot_backend) != 1L ||
            is.na(plot_backend) || !plot_backend %in% c("jgd", "auto")) {
        return(FALSE)
    }
    if (!nzchar(Sys.getenv("JGD_SOCKET", unset = ""))) {
        return(FALSE)
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
        prepared <- tool_environment$tool_library_prepare(
            "jgd",
            VSCODE_R_JGD_MINIMUM_VERSION,
            tool_root,
            consent_directory,
            plot_backend,
            consent_timeout_seconds = 10,
            install_timeout_seconds = 10,
            resolution_timeout_seconds = 5
        )
        if (is.null(prepared)) {
            message("vscode-R optional jgd installation was not approved; using the available plot fallback.")
            return(FALSE)
        }
        namespace <- tool_environment$tool_library_load(
            "jgd", VSCODE_R_JGD_MINIMUM_VERSION, tool_root
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
