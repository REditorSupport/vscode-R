loadNamespace("jsonlite")
loadNamespace("yaml")

pkgs <- .packages(all.available = TRUE)
templates <- new.env()
template_dirs <- lapply(pkgs, function(pkg) {
    dir <- system.file("rmarkdown/templates", package = pkg)
    if (dir.exists(dir)) {
        ids <- list.dirs(dir, full.names = FALSE, recursive = FALSE)
        for (id in ids) {
            file <- file.path(dir, id, "template.yaml")
            if (file.exists(file)) {
                data <- yaml::read_yaml(file)
                data$id <- id
                data$package <- pkg
                templates[[paste0(pkg, "::", id)]] <- data
            }
        }
    }
})

template_list <- unname(as.list(templates))
lim <- Sys.getenv("VSCR_LIM")
json <- jsonlite::toJSON(template_list, auto_unbox = TRUE)
cat(lim, json, lim, sep = "\n", file = stdout())
