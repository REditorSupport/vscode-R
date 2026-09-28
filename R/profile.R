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

add_lib_paths <- Sys.getenv("VSCR_LIB_PATHS")
if (nzchar(add_lib_paths)) {
    add_lib_paths <- strsplit(add_lib_paths, "\n", fixed = TRUE)[[1L]]
    .libPaths(c(.libPaths(), add_lib_paths))
}

if (requireNamespace("sess", quietly = TRUE)) {
    local({
        plot_backend <- Sys.getenv("SESS_PLOT_BACKEND", "auto")
        sess::connect(
            use_rstudioapi = as.logical(Sys.getenv("SESS_RSTUDIOAPI", "TRUE")),
            use_httpgd = (plot_backend %in% c("auto", "httpgd")),
            use_jgd = (plot_backend %in% c("auto", "jgd"))
        )
    })
}
