# Source the original .Rprofile
local({
    try_source <- function(file) {
        if (file.exists(file)) {
            source(file)
            TRUE
        } else {
            FALSE
        }
    }

    r_profile <- Sys.getenv("R_PROFILE_USER_OLD")
    Sys.setenv(
        R_PROFILE_USER_OLD = "",
        R_PROFILE_USER = r_profile
    )

    if (nzchar(r_profile)) {
        try_source(r_profile)
    } else {
        try_source(".Rprofile") || try_source(file.path("~", ".Rprofile"))
    }

    invisible()
})

if (requireNamespace("sess", quietly = TRUE)) {
    sess::sess_app(
        ipc_path = Sys.getenv("SESS_IPC_PATH"),
        port = as.integer(Sys.getenv("SESS_PORT")),
        token = Sys.getenv("SESS_TOKEN"),
        use_rstudioapi = as.logical(Sys.getenv("SESS_RSTUDIOAPI", "TRUE")),
        use_httpgd = as.logical(Sys.getenv("SESS_USE_HTTPGD", "TRUE"))
    )
}
