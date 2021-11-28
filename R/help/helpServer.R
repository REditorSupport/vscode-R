# get values from extension-set env values
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
