if (file.exists(".Rprofile")) {
  source(".Rprofile")
} else if (file.exists("~/.Rprofile")) {
  source("~/.Rprofile")
}

if (is.null(getOption("vscodeR"))) {
  source(file.path(Sys.getenv(if (.Platform$OS.type == "windows") "USERPROFILE" else "HOME"), ".vscode-R", "init.R"))
}
