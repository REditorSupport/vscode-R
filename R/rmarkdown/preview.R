# requires rmarkdown package to run (and knitr)
if (!requireNamespace("rmarkdown", quietly = TRUE)) {
    stop("Previewing documents requires the {rmarkdown} package.")
}

# get values from extension-set env values
knit_dir <- Sys.getenv("VSCR_KNIT_DIR")
lim <- Sys.getenv("VSCR_LIM")
file_path <- Sys.getenv("VSCR_FILE_PATH")
output_file_loc <- Sys.getenv("VSCR_OUTPUT_FILE")
tmp_dir <- Sys.getenv("VSCR_TMP_DIR")

# if an output format ends up as html, we should not overwrite
# the format with rmarkdown::html_document()
set_html <- tryCatch(
    expr = {
        lines <- suppressWarnings(readLines(file_path, encoding = "UTF-8"))
        out <- rmarkdown:::output_format_from_yaml_front_matter(lines)
        output_format <- rmarkdown:::create_output_format(out$name, out$options)
        if (!output_format$pandoc$to == "html") {
            rmarkdown::html_document()
        } else {
            NULL
        }
    }, error = function(e) {
        rmarkdown::html_document()
    }
)

# set the knitr chunk eval directory
# mainly affects source calls
knitr::opts_knit[["set"]](root.dir = knit_dir)

# render and get file output location for use in extension
cat(
    lim,
    rmarkdown::render(
        file_path,
        output_format = set_html,
        output_file = output_file_loc,
        intermediates_dir = tmp_dir
    ),
    lim,
    sep = ""
)