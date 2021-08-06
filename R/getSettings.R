# try to find the VSC settings file.
# can be tricky for specific platforms, such as WSL,
# where the settings are located on the window's side
fileCon <- if (file.exists("~/.config/Code/User/settings.json")) {
    # windows
    file("~/.config/Code/User/settings.json")
} else if (file.exists("~/Library/Application Support/Code/User/settings.json")) {
    # mac
    file("~/.config/Code/User/settings.json")
} else if (file.exists("~/.config/Code/User/settings.json")) {
    # linux
    file("~/.config/Code/User/settings.json")
} else if (file.exists(paste0("/mnt///c/Users/", Sys.getenv("USER"), "/AppData/Roaming/Code/User/settings.json"))) {
    # WSL
    file(paste0("/mnt///c/Users/", Sys.getenv("USER"), "/AppData/Roaming/Code/User/settings.json"))
} else {
    NULL
}

# settings.json can result in errors if read via fromJSON
vsc_settings <- suppressWarnings(jsonlite::fromJSON(paste(readLines(fileCon), collapse = "")))
ops <- Reduce(c, vsc_settings[grep("r.rOptions", names(vsc_settings))])

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