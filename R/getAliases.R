
hasJsonLite <- require("jsonlite", quietly = TRUE)

if (!hasJsonLite) {
    json <- ""
} else{
    # get installed packages, making sure that high priority packages are on top
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
            info[["aliases"]] <- as.list(readRDS(filename))
        }
        info
    })
    names(ret) <- rownames(ip)

    json <- jsonlite::toJSON(ret, auto_unbox = TRUE)
}

lim <- "---vsc---" # must match the lim used in ts!
cat(lim, json, lim, "\n", sep = "")
