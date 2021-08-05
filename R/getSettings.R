fileCon <- file("~/.config/Code/User/settings.json")
vsc_settings <- jsonlite::fromJSON(paste(readLines(fileCon), collapse = ""))
ops <- vsc_settings[grep("r.rOptions", names(vsc_settings))]$r.rOptions


.vsc.setOption <- function(x) {
    val <- ops[[x]]
    switch(
        x,
        "vsc.plot" = options("vsc.plot" = val),
        "vsc.globalenv" = options("vsc.globalenv" = val)
        # etc.
    )
}

lapply(names(ops), .vsc.setOption)
