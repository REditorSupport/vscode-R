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

lim <- Sys.getenv("VSCR_LIM")

NEW_PACKAGE_STRING <- "NEW_PACKAGES"

cat(
    lim,
    tools::startDynamicHelp(),
    lim,
    sep = ""
)

currentPackages <- NULL

while (TRUE) {
    newPackages <- installed.packages(fields = "Packaged")[, c("Version", "Packaged")]
    if (!identical(currentPackages, newPackages)) {
        if (!is.null(currentPackages)) {
            cat(NEW_PACKAGE_STRING, "\n")
        }
        currentPackages <- newPackages
    }
    Sys.sleep(1)
}
