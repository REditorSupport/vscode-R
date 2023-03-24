add_lib_paths <- Sys.getenv("VSCR_LIB_PATHS")
if (nzchar(add_lib_paths)) {
  add_lib_paths <- strsplit(add_lib_paths, "\n", fixed = TRUE)[[1L]]
  .libPaths(c(.libPaths(), add_lib_paths))
}

loadNamespace("jsonlite")

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
    res <- tryCatch(
      expr = as.list(readRDS(filename)),
      error = conditionMessage
    )
    if (is.list(res)) {
      info$aliases <- res
    } else {
      info$error <- res
    }
  }
  info
})

names(ret) <- rownames(ip)

lim <- Sys.getenv("VSCR_LIM")
json <- jsonlite::toJSON(ret, auto_unbox = TRUE)

cat(lim, json, lim, sep = "\n", file = stdout())
