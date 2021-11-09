# get values from extension-set env values
lim <- Sys.getenv("VSCR_LIM")

SLEEP_DURATION <- 1

NEW_PACKAGE_STRING <- "NEW_PACKAGES"

cat(
    lim,
    tools::startDynamicHelp(),
    lim,
    sep = ""
)

currentPackages <- .packages(all.available = TRUE)

while (TRUE) {
    Sys.sleep(1)
    newPackages <- .packages(all.available = TRUE)
    if (!identical(currentPackages, newPackages)) {
        cat(NEW_PACKAGE_STRING, "\n")
        currentPackages <- newPackages
    }
}
