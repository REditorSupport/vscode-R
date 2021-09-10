# requires rmarkdown package to run (and knitr)
if (!requireNamespace("rmarkdown", quietly = TRUE)) {
    stop("Knitting requires the {rmarkdown} package.")
}

# get values from extension-set env values

knit_dir <- Sys.getenv("VSCR_KNIT_DIR")
lim <- Sys.getenv("VSCR_LIM")
knit_command <- Sys.getenv("VSCR_KNIT_COMMAND")

# set the knitr chunk eval directory
# mainly affects source calls
knitr::opts_knit[["set"]](root.dir = knit_dir)

# render and get file output location for use in extension
cat(
    lim,
    eval(parse(text = knit_command)),
    lim,
    sep = ""
)