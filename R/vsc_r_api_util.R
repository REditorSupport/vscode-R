make_rs_range <- function(vsc_selection) {
    # vscode positions are zero indexed
    # rstudioapi is one indexed
    rstudioapi::document_range(
        start = rstudioapi::document_position(
            row = vsc_selection$start$line + 1,
            column = vsc_selection$start$character + 1
        ),
        end = rstudioapi::document_position(
            row = vsc_selection$end$line + 1,
            column = vsc_selection$end$character + 1
        )
    )
}

extract_document_ranges <- function(vsc_selections) {
    lapply(vsc_selections, make_rs_range)
}

to_content_lines <- function(contents) strsplit(contents, "\n")[[1]]

extract_range_text <- function(range, content_lines) {
    if (!range_has_text(range)) {
        return("")
    }

    content_rows <-
        content_lines[(range$start["row"]):(range$end["row"])]
    content_rows[length(content_rows)] <-
        substring(
            content_rows[length(content_rows)],
            1,
            range$end["column"]
        )
    content_rows[1] <-
        substring(
            content_rows[1],
            range$start["column"]
        )

    paste0(content_rows, collapse = "\n")
}

range_has_text <- function(range) {
    (range$end["row"] - range$start["row"]) +
        (range$end["column"] - range$start["column"]) > 0
}

make_rs_document_selection <- function(ranges, range_texts) {
    selection_data <-
        mapply(
            function(range, text) {
                list(
                    range = range,
                    text = text
                )
            },
            ranges,
            range_texts,
            SIMPLIFY = FALSE
        )
    structure(selection_data,
        class = "document_selection"
    )
}

make_rs_document_context <-
    function(vsc_editor_context) {
        document_ranges <-
            extract_document_ranges(vsc_editor_context$selection)
        content_lines <- to_content_lines(vsc_editor_context$contents)
        document_range_texts <-
            lapply(
                document_ranges,
                extract_range_text,
                content_lines
            )
        document_selection <-
            make_rs_document_selection(
                document_ranges,
                document_range_texts
            )

        structure(list(
            id = vsc_editor_context$id$external,
            path = vsc_editor_context$path,
            contents = content_lines,
            selections = document_selection
        ),
        class = "document_context"
        )
    }