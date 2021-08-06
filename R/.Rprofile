# Source VSCode-R options
# * source this first, so that
# * .Rprofile settings are respected
local({
  homedir <- Sys.getenv(
    if (.Platform$OS.type == "windows") "USERPROFILE" else "HOME"
  )

  fileCon <- if (file.exists(file.path(homedir, ".vscode-R", "settings.json"))) {
    file(file.path(homedir, ".vscode-R", "settings.json"))
  } else {
    NULL
  }

  if (!is.null(fileCon)) {
    # settings.json can result in errors if read via fromJSON
    vsc_settings <- suppressWarnings(
      jsonlite::fromJSON(paste(readLines(fileCon), collapse = ""))[["rOptions"]]
    )
    ops <- Reduce(c, vsc_settings)

    # non-string values have to be converted from
    # strings due to VSC settings limitations
    get_val <- function(x) {
      if (is.logical(x)) {
        x
      } else {
        switch(EXPR = x,
          "Two" = "Two",
          "Active" = "Active",
          "Beside" = "Beside",
          "FALSE" = FALSE,
          "TRUE" = TRUE,
          "0" = 0,
          "2" = 2,
          x
        )
      }
    }

    lapply(names(ops), function(x) {
      val <- get_val(ops[[x]])

      # lhs = vscode setting name
      # rhs name = R options name
      switch(EXPR = x,
        # arrays
        "vsc.plot" = options("vsc.plot" = val),
        "vsc.browser" = options("vsc.browser" = val),
        "vsc.viewer" = options("vsc.viewer" = val),
        "vsc.pageViewer" = options("vsc.page_viewer" = val),
        "vsc.view" = options("vsc.view" = val),
        "vsc.helpPanel" = options("vsc.helpPanel" = val),
        "vsc.strMaxLevel" = options("vsc.str.max.level" = val),
        # bools
        "vsc.rstudioapi" = options("vsc.rstudioapi" = val),
        "vsc.useHttpgd" = options("vsc.use_httpgd" = val),
        "vsc.globalEnv" = options("vsc.globalenv" = val),
        "vsc.showObjectSize" = options("vsc.show_object_size" = val)
      )
    })

    close(fileCon)
  }
})

# Source the original .Rprofile
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

# Run vscode initializer
local({
  init_file <- Sys.getenv("VSCODE_INIT_R")
  if (nzchar(init_file)) {
    source(init_file, chdir = TRUE, local = TRUE)
  }
})
