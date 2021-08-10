# This file is executed with its containing directory as wd

# Remember the working directory (should be extension subfolder that contains this script)
dir_init <- getwd()


# This function is run at the beginning of R's startup sequence
# Code that is meant to be run at the end of the startup should go in `init_last`
init_first <- function() {
  # return early if not a vscode term session
  if (
    !interactive()
    || Sys.getenv("RSTUDIO") != ""
    || Sys.getenv("TERM_PROGRAM") != "vscode"
  ) {
    return()
  }

  # check requried packages
  required_packages <- c("jsonlite", "rlang")
  missing_packages <- required_packages[
    !vapply(required_packages, requireNamespace,
      logical(1L), quietly = TRUE)
  ]

  if (length(missing_packages)) {
    message(
      "VSCode R Session Watcher requires ",
      toString(missing_packages), ". ",
      "Please install manually in order to use VSCode-R."
    )
  } else {
    # Initialize vsc utils after loading other default packages
    assign(".First.sys", init_last, envir = globalenv())
  }
}

old.First.sys <- .First.sys

# Overwrite for `.First.sys`
# Is used to make sure that all default packages are loaded first
# Will be assigned to and called from the global environment,
# Will be run with wd being the user's working directory (!)
init_last <- function() {
  old.First.sys()

  # cleanup previous version
  removeTaskCallback("vscode-R")
  options(vscodeR = NULL)
  .vsc.name <- "tools:vscode"
  if (.vsc.name %in% search()) {
    detach(.vsc.name, character.only = TRUE)
  }

  # Source vsc utils in new environmeent
  .vsc <- new.env()
  source(file.path(dir_init, "vsc.R"), local = .vsc)

  # attach functions that are meant to be called by the user/vscode
  exports <- local({
    .vsc <- .vsc
    .vsc.attach <- .vsc$attach
    .vsc.view <- .vsc$show_dataview
    .vsc.browser <- .vsc$show_browser
    .vsc.viewer <- .vsc$show_viewer
    .vsc.page_viewer <- .vsc$show_page_viewer

    # assign functions that are optional:
    for (funcName in c("View")) {
      if (funcName %in% ls(.vsc)) {
        assign(funcName, .vsc[[funcName]])
      }
    }
    environment()
  })
  attach(exports, name = .vsc.name, warn.conflicts = FALSE)

  # overwrite S3 bindings from other packages
  suppressWarnings({
    if (!identical(getOption("vsc.helpPanel", "Two"), FALSE)) {
      # Overwrite print function for results of `?`
      .vsc$.S3method(
        "print",
        "help_files_with_topic",
        .vsc$print.help_files_with_topic
      )
      # Overwrite print function for results of `??`
      .vsc$.S3method(
        "print",
        "hsearch",
        .vsc$print.hsearch
      )
    }
    # Further S3 overwrites can go here
    # ...
  })

  # remove this function from globalenv()
  suppressWarnings(
    rm(".First.sys", envir = globalenv())
  )


  # Attach to vscode
  exports$.vsc.attach()

  # Import VSC-R settings
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
      rSettings <- c(
        "plot.useHttpgd",
        "workspaceViewer.showObjectSize",
        "session.emulateRStudioAPI",
        "session.levelOfObjectDetail",
        "session.watchGlobalEnvironment",
        "session.viewers.Plot Column",
        "session.viewers.Browser Column",
        "session.viewers.Viewer Column",
        "session.viewers.Page Viewer Column",
        "session.viewers.View Column",
        "session.viewers.Help Panel Column"
      )

      # settings.json can result in errors if read via fromJSON
      vsc_settings <- suppressWarnings(
        unlist(
          jsonlite::fromJSON(paste(readLines(fileCon), collapse = ""))
        )
      )
      ops <- na.omit(vsc_settings[rSettings])

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
            "Disable" = FALSE,
            "FALSE" = FALSE,
            "TRUE" = TRUE,
            "Minimal" = 0,
            "Detailed" = 2,
            x
          )
        }
      }

      setOption <- function(lhs, rhs) {
        if (is.null(options()[[lhs]])) {
          ops <- list(rhs)
          names(ops) <- lhs
          options(ops)
        }
      }

      lapply(names(ops), function(x) {
        val <- get_val(ops[[x]])

        # lhs = vscode setting name
        # rhs name = R options name
        switch(EXPR = x,
          # arrays
          `session.viewers.Plot Column` = setOption("vsc.plot", val),
          `session.viewers.Browser Column` = setOption("vsc.browser", val),
          `session.viewers.Viewer Column` = setOption("vsc.viewer", val),
          `session.viewers.Page Viewer Column` = setOption("vsc.page_viewer", val),
          `session.viewers.View Column` = setOption("vsc.view", val),
          `session.viewers.Help Panel Column` = setOption("vsc.helpPanel", val),
          `session.levelOfObjectDetail` = setOption("vsc.str.max.level", val),
          # bools
          `plot.useHttpgd` = setOption("vsc.use_httpgd", val),
          `session.emulateRStudioAPI` = setOption("vsc.rstudioapi", val),
          `session.watchGlobalEnvironment` = setOption("vsc.globalenv", val),
          `workspaceViewer.showObjectSize` = setOption("vsc.show_object_size", val)
        )
      })

      close(fileCon)
    }
  })

  invisible()
}

init_first()
