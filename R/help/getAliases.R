.paths <- .libPaths()

add_lib_paths <- Sys.getenv("VSCR_LIB_PATHS")
if (nzchar(add_lib_paths)) {
    add_lib_paths <- strsplit(add_lib_paths, "\n", fixed = TRUE)[[1L]]
    .paths <- c(.paths, add_lib_paths)
}

use_renv_lib_path <- Sys.getenv("VSCR_USE_RENV_LIB_PATH")
use_renv_lib_path <- if (nzchar(use_renv_lib_path)) as.logical(use_renv_lib_path) else FALSE
if (use_renv_lib_path) {
    if (requireNamespace("renv", quietly = TRUE)) {
        .paths <- c(.paths, renv::paths$cache())
    } else {
        warning("renv package is not installed. Please install renv to use renv library path.")
    }
}

.libPaths(.paths)
message("R library paths: ", paste(.libPaths(), collapse = "\n"))

loadNamespace("jsonlite")

ip <- installed.packages()

ord <- order(ip[, "Priority"])
ip <- ip[ord, ]

ret <- lapply(rownames(ip), function(row) {
    libPath <- ip[row, "LibPath"]
    pkg <- ip[row, "Package"]
    filename <- file.path(libPath, pkg, "help", "aliases.rds")
    info <- list(
        package = pkg,
        libPath = libPath,
        aliasFile = filename,
        aliases = NULL
    )
    if (file.exists(filename)) {
        res <- tryCatch(
            expr = as.list(readRDS(filename)),
            error = conditionMessage
        )
        if (is.list(res)) {
            info$aliases <- res
        } else {
            info$error <- res
        }
    }
    info
})

names(ret) <- rownames(ip)

lim <- Sys.getenv("VSCR_LIM")
json <- jsonlite::toJSON(ret, auto_unbox = TRUE)

cat(lim, json, lim, sep = "\n", file = stdout())
