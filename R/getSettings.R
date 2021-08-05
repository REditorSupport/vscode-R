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


vsc_settings <- jsonlite::fromJSON(paste(readLines(fileCon), collapse = ""))
ops <- vsc_settings[grep("r.rOptions", names(vsc_settings))]$r.rOptions


lapply(names(ops), function(x) {
    val <- ops[[x]]
    switch(x,
        "vsc.plot" = options("vsc.plot" = val),
        "vsc.globalenv" = options("vsc.globalenv" = val)
        # etc.
    )
})
