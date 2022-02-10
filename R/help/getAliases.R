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

lim <- Sys.getenv("VSCR_LIM")
json <- jsonlite::toJSON(ret, auto_unbox = TRUE)

cat(lim, json, lim, sep = "\n", file = stdout())
