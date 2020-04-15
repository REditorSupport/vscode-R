local({
  try_source <- function(file) {
    if (file.exists(file)) {
      source(file)
      TRUE
    } else {
      FALSE
    }
  }

  try_source(Sys.getenv("R_PROFILE_USER_OLD")) ||
    try_source(".Rprofile") ||
    try_source(file.path("~", ".Rprofile"))
})

if (is.null(getOption("vscodeR"))) {
  source(file.path(
    Sys.getenv(if (.Platform$OS.type == "windows") "USERPROFILE" else "HOME"),
    ".vscode-R", "init.R")
  )
}
