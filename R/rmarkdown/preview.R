# requires rmarkdown package to run (and knitr)
if (!requireNamespace(rmarkdown, quietly = TRUE)) {
    stop("Previewing documents requires the {rmarkdown} package.")
}

# get values from extension-set env values

knit_dir <- Sys.getenv("VSCR_KNIT_DIR")
lim <- Sys.getenv("VSCR_LIM")
file_path <- Sys.getenv("VSCR_FILE_PATH")
output_file_loc <- Sys.getenv("VSCR_OUTPUT_FILE")
tmp_dir <- Sys.getenv("VSCR_TMP_DIR")

# set the knitr chunk eval directory
# mainly affects source calls
knitr::opts_knit[["set"]](root.dir = knit_dir)

# render and get file output location for use in extension
cat(
    lim,
    rmarkdown::render(
        file_path,
        output_format = rmarkdown::html_document(),
        output_file = output_file_loc,
        intermediates_dir = tmp_dir
    ),
    lim,
    sep = ""
)