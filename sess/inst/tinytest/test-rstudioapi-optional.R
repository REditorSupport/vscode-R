# sess only suggests rstudioapi: it must load and start its emulation without the
# package, and patch it whenever it is loaded later.
local({
  description <- utils::packageDescription("sess", fields = c("Imports", "Suggests"))
  expect_false(grepl("rstudioapi", description$Imports, fixed = TRUE))
  expect_true(grepl("rstudioapi", description$Suggests, fixed = TRUE))

  root <- tempfile("sess-rstudioapi-")
  dir.create(root)
  on.exit(unlink(root, recursive = TRUE), add = TRUE)
  r_command <- function(program) file.path(R.home("bin"), program)

  # A directory without a valid installation shadows any real rstudioapi.
  absent_library <- file.path(root, "absent-library")
  dir.create(file.path(absent_library, "rstudioapi"), recursive = TRUE)
  writeLines(c("Package: rstudioapi", "Version: 0.0.0"),
             file.path(absent_library, "rstudioapi", "DESCRIPTION"))

  # A minimal installed package named rstudioapi, loaded only on demand.
  stub_source <- file.path(root, "rstudioapi")
  dir.create(file.path(stub_source, "R"), recursive = TRUE)
  writeLines(c("Package: rstudioapi", "Version: 0.4.0", "Title: Fixture",
               "Description: Local rstudioapi fixture.", "License: MIT",
               "Author: Test Author", "Maintainer: Test Author <test@example.com>"),
             file.path(stub_source, "DESCRIPTION"))
  writeLines("isAvailable <- function(version_needed = NULL, child_ok = FALSE) 'original'",
             file.path(stub_source, "R", "api.R"))
  writeLines("export(isAvailable)", file.path(stub_source, "NAMESPACE"))
  stub_library <- file.path(root, "stub-library")
  dir.create(stub_library)
  installed <- suppressWarnings(system2(
    r_command("R"),
    c("CMD", "INSTALL", paste0("--library=", shQuote(stub_library)), shQuote(stub_source)),
    stdout = TRUE, stderr = TRUE
  ))
  expect_null(attr(installed, "status"))

  script <- file.path(root, "child.R")
  writeLines(c(
    "args <- commandArgs(TRUE); scenario <- args[[1L]]; result <- args[[2L]]",
    "hook <- packageEvent('rstudioapi', 'onLoad')",
    "loadNamespace('sess')",
    "lines <- c(available=as.character(requireNamespace('rstudioapi', quietly=TRUE)))",
    "if (scenario == 'stub') unloadNamespace('rstudioapi')",
    "lines[['loaded_with_sess']] <- as.character('rstudioapi' %in% loadedNamespaces())",
    "sess_env <- sess:::.sess_env; sess_env$latest_plot_path <- tempfile(fileext='.png')",
    "sess:::runtime_start(use_rstudioapi=TRUE, plot_backend='standard')",
    "lines[['loaded_after_start']] <- as.character('rstudioapi' %in% loadedNamespaces())",
    "lines[['hook']] <- as.character(length(getHook(hook)))",
    "if (scenario == 'stub') {",
    "  loadNamespace('rstudioapi')",
    "  lines[['patched']] <- as.character(isTRUE(rstudioapi::isAvailable()))",
    "}",
    "sess:::runtime_stop()",
    "lines[['hook_after_stop']] <- as.character(length(getHook(hook)))",
    "writeLines(paste(names(lines), lines, sep='='), result)"
  ), script)

  run_child <- function(scenario, library) {
    result <- file.path(root, paste0(scenario, "-result"))
    previous <- Sys.getenv("R_LIBS", unset = NA_character_)
    on.exit(if (is.na(previous)) Sys.unsetenv("R_LIBS") else Sys.setenv(R_LIBS = previous))
    sess_library <- dirname(system.file(package = "sess"))
    Sys.setenv(R_LIBS = paste(unique(c(library, sess_library, .libPaths())),
                              collapse = .Platform$path.sep))
    output <- system2(r_command("Rscript"),
                      c("--vanilla", shQuote(script), scenario, shQuote(result)),
                      stdout = TRUE, stderr = TRUE)
    expect_null(attr(output, "status"), info = paste(output, collapse = "\n"))
    if (file.exists(result)) readLines(result) else character()
  }

  absent <- run_child("absent", absent_library)
  expect_equal(absent, c("available=FALSE", "loaded_with_sess=FALSE",
                         "loaded_after_start=FALSE", "hook=1", "hook_after_stop=0"))

  present <- run_child("stub", stub_library)
  expect_equal(present, c("available=TRUE", "loaded_with_sess=FALSE",
                          "loaded_after_start=FALSE", "hook=1", "patched=TRUE",
                          "hook_after_stop=0"))
})
