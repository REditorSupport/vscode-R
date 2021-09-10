# get values from extension-set env values
lim <- Sys.getenv("VSCR_LIM")

cat(
    lim,
    tools::startDynamicHelp(),
    lim,
    sep = ""
)

while (TRUE) Sys.sleep(1)
