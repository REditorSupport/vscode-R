add_lib_paths <- Sys.getenv("VSCR_LIB_PATHS")
if (nzchar(add_lib_paths)) {
  add_lib_paths <- strsplit(add_lib_paths, "\n", fixed = TRUE)[[1L]]
  .libPaths(c(.libPaths(), add_lib_paths))
}

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
