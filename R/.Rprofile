local({
  try_source <- function(file) {
    if (file.exists(file)) {
      source(file)
      TRUE
    } else {
      FALSE
    }
  }

  r_profile <- Sys.getenv("R_PROFILE_USER_OLD")
  Sys.setenv(
    R_PROFILE_USER_OLD = "",
    R_PROFILE_USER = r_profile
  )

  if (nzchar(r_profile)) {
    try_source(r_profile)
  } else {
    try_source(".Rprofile") || try_source(file.path("~", ".Rprofile"))
  }

  invisible()
})

if (!exists(".vsc")) {
  source(file.path(
    Sys.getenv(if (.Platform$OS.type == "windows") "USERPROFILE" else "HOME"),
    ".vscode-R", "init.R")
  )
}
