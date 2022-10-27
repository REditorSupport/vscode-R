# requires rmarkdown package to run (and knitr)
if (!requireNamespace("rmarkdown", quietly = TRUE)) {
    stop("Knitting requires the {rmarkdown} package.")
}

# get values from extension-set env values
# Hiding values is necessary to prevent their accidental removal
# See: https://github.com/REditorSupport/vscode-R/issues/860
attach(
    local({
        .vsc.knit_dir <- Sys.getenv("VSCR_KNIT_DIR")
        .vsc.knit_lim <- Sys.getenv("VSCR_LIM")
        .vsc.knit_command <- Sys.getenv("VSCR_KNIT_COMMAND")
        environment()
    }),
    name = "tools:vscode",
    warn.conflicts = FALSE
)


# set the knitr chunk eval directory
# mainly affects source calls
if (nzchar(.vsc.knit_dir)) {
    knitr::opts_knit[["set"]](root.dir = .vsc.knit_dir)
}

# render and get file output location for use in extension
cat(
    .vsc.knit_lim,
    eval(parse(text = .vsc.knit_command)),
    .vsc.knit_lim,
    sep = "",
    file = stdout()
)
