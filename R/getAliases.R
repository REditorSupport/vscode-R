
# get installed packages, making sure that high priority packages are on top
ip <- installed.packages()

ord <- order(ip[, "Priority"])
ip <- ip[ord, ]

ret <- list()

for (row in rownames(ip)) {
    libPath <- ip[row, "LibPath"]
    pkg <- ip[row, "Package"]
    filename <- file.path(libPath, pkg, "help", "aliases.rds")
    tmp <- list(
        package = pkg,
        libPath = libPath,
        aliasFile = filename
    )
    if (file.exists(filename)) {
        tmp[["aliases"]] <- as.list(readRDS(filename))
    }
    ret[[row]] <- tmp
}

json <- jsonlite::toJSON(ret, auto_unbox = TRUE)

lim <- "---vsc---" # must match the lim used in ts!
cat(lim, json, lim, "\n")
