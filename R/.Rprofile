if (nzchar(Sys.getenv("R_PROFILE_USER_OLD"))) {
  source(Sys.getenv("R_PROFILE_USER_OLD"))
} else if (file.exists(".Rprofile")) {
  source(".Rprofile")
} else if (file.exists("~/.Rprofile")) {
  source("~/.Rprofile")
}

if (is.null(getOption("vscodeR"))) {
  source(file.path(Sys.getenv(if (.Platform$OS.type == "windows") "USERPROFILE" else "HOME"), ".vscode-R", "init.R"))
}
