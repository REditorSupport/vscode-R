requireNamespace("jsonlite")

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

file <- Sys.getenv("VSCR_FILE")
jsonlite::write_json(ret, file, auto_unbox = TRUE)
