args <- commandArgs(TRUE)
if (length(args) != 2L) stop("Expected a private library and agent configuration")
.libPaths(c(args[[1L]], .libPaths()))
sess::run_worker(args[[2L]])
