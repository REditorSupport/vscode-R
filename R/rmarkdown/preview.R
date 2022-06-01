# requires rmarkdown package to run (and knitr)
if (!requireNamespace("rmarkdown", quietly = TRUE)) {
    stop("Previewing documents requires the {rmarkdown} package.")
}

# get values from extension-set env values
# Hiding values is necessary to prevent their accidental removal
# See: https://github.com/REditorSupport/vscode-R/issues/860
attach(
    local({
        .vsc.knit_dir <- Sys.getenv("VSCR_KNIT_DIR")
        .vsc.knit_lim <- Sys.getenv("VSCR_LIM")
        .vsc.file_path <- Sys.getenv("VSCR_FILE_PATH")
        .vsc.output_file_loc <- Sys.getenv("VSCR_OUTPUT_FILE")
        .vsc.tmp_dir <- Sys.getenv("VSCR_TMP_DIR")

        # if an output format ends up as html, we should not overwrite
        # the format with rmarkdown::html_document()
        .vsc.set_html <- tryCatch(
            expr = {
                lines <- suppressWarnings(readLines(.vsc.file_path, encoding = "UTF-8"))
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
    rmarkdown::render(
        .vsc.file_path,
        output_format = .vsc.set_html,
        output_file = .vsc.output_file_loc,
        intermediates_dir = .vsc.tmp_dir
    ),
    .vsc.knit_lim,
    sep = "",
    file = stdout()
)
