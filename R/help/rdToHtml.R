#' Converts an .Rd file to HTML (output is printed to stdout)
#'
#' Execute this with the following trailing commandline args:
#'   1. path of an .Rd file
#'   2. name of the package
#'   3. version string of the package
#'   4. root dir of the package

args <- base::commandArgs(TRUE)

e <- tools::loadPkgRdMacros(args[4])
e <- tools::loadRdMacros(file.path(R.home("share"), "Rd", "macros", "system.Rd"), macros = e)

tools::Rd2HTML(
    args[1],
    package = args[2:3],
    dynamic = TRUE,
    encoding = "utf-8",
    macros = e,
    stages = c("build", "install", "render")
)
