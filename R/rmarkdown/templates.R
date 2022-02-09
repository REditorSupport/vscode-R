requireNamespace("jsonlite")
requireNamespace("yaml")

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
file <- Sys.getenv("VSCR_FILE")

jsonlite::write_json(template_list, file, auto_unbox = TRUE)
