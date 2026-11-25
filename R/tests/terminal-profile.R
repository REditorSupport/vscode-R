# Exercise the real terminal startup file and a child Rscript in the same project.
wrapper <- normalizePath("R/profile.R")
rscript <- file.path(
  R.home("bin"),
  if (.Platform$OS.type == "windows") "Rscript.exe" else "Rscript"
)
root <- tempfile("terminal-profile-")
project <- file.path(root, "project")
user_home <- file.path(root, "home")
dir.create(project, recursive = TRUE)
dir.create(user_home)
setwd(project)
Sys.setenv(
  R_USER = user_home,
  HOME = user_home,
  R_LIBS = paste(.libPaths(), collapse = .Platform$path.sep),
  RENV_PATHS_ROOT = file.path(root, "renv-state"),
  RENV_CONFIG_SANDBOX_ENABLED = "FALSE"
)
Sys.unsetenv(c("VSCODE_R_SESS_PKG_PATH", "VSCODE_R_SESS_STARTUP_FILE", "CALLR_CHILD_R_LIBS"))
writeLines('options(profile.ran = "home")', file.path(user_home, ".Rprofile"))
writeLines('options(profile.ran = "project")', ".Rprofile")
writeLines('options(profile.ran = "custom")', "custom profile.R")
writeLines(
  c(
    'stopifnot(identical(getOption("profile.ran", "none"), Sys.getenv("EXPECTED_PROFILE")))',
    'stopifnot(identical(Sys.getenv("R_PROFILE_USER", unset = "<unset>"), Sys.getenv("EXPECTED_ENV")))',
    'stopifnot(is.na(Sys.getenv("R_PROFILE_USER_OLD", unset = NA_character_)))'
  ),
  "check.R"
)
writeLines(
  c(
    'source("check.R")',
    'stopifnot(system2(Sys.getenv("TEST_RSCRIPT"), c("--no-environ", "--no-site-file", "check.R")) == 0L)'
  ),
  "parent.R"
)
Sys.setenv(TEST_RSCRIPT = rscript)

check_startup <- function(original, expected_profile) {
  if (is.na(original)) {
    Sys.unsetenv("R_PROFILE_USER_OLD")
  } else {
    Sys.setenv(R_PROFILE_USER_OLD = original)
  }
  Sys.setenv(
    R_PROFILE_USER = wrapper,
    EXPECTED_ENV = if (is.na(original)) "<unset>" else original,
    EXPECTED_PROFILE = expected_profile
  )
  stopifnot(system2(rscript, c("--no-environ", "--no-site-file", "parent.R")) == 0L)
}

check_startup(NA_character_, "project")
check_startup("custom profile.R", "custom")
check_startup("missing.R", "none")
# Sys.setenv(name = "") unsets the variable on Windows.
if (.Platform$OS.type != "windows") {
  check_startup("", "none")
}
unlink(".Rprofile")
check_startup(NA_character_, "home")

# renv's project profile opts into loading the user's profile for both processes.
Sys.unsetenv(c("R_PROFILE_USER", "R_PROFILE_USER_OLD"))
writeLines(c("options(renv.consent = TRUE)", "renv::init(bare = TRUE, force = TRUE)"), "init.R")
stopifnot(system2(rscript, c("--vanilla", "init.R")) == 0L)
write(
  'stopifnot("renv" %in% loadedNamespaces(), normalizePath(renv::project()) == normalizePath("."))',
  "check.R",
  append = TRUE
)
Sys.setenv(RENV_CONFIG_USER_PROFILE = "FALSE")
check_startup(NA_character_, "none")
Sys.setenv(RENV_CONFIG_USER_PROFILE = "TRUE")
check_startup(NA_character_, "home")
