rstudioapi_call <- function(action, ...) {
    request_response("rstudioapi", action = action, args = list(...))
}

rstudioapi_patch_hook <- function(api_env) {
    patch_rstudioapi_fn <-
        function(old, new) {
            if (namespace_has(old, "rstudioapi")) {
                assignInNamespace(
                    x = old,
                    value = new,
                    ns = "rstudioapi"
                )
            }
        }
    ## make assignments to functions found in api_env namespace
    ## that have function with the same name in {rstudioapi} namespace
    api_list <- as.list(api_env)
    mapply(
        patch_rstudioapi_fn,
        names(api_list),
        api_list
    )
}

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

to_content_lines <- function(contents, ranges) {
    content_lines <- strsplit(contents, "\n|\r\n|\r$")[[1]]


    # edge case handling: The cursor is at the start of a new empty line,
    # and that line is the final line.
    range_end_row <- unlist(lapply(ranges, function(range) range$end["row"]))
    last_row <- max(range_end_row)
    if (last_row == length(content_lines) + 1) {
        content_lines <- c(content_lines, "")
    }

    content_lines
}


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
            range$end["column"] - 1
            # it's a minus 1 here because the selection end point is the number
            # of the first unselected column. I.e. range 1 - 2 is all of
            # columns >= 1 and < 2, which is column 1.
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
        content_lines <-
            to_content_lines(vsc_editor_context$contents, document_ranges)
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

is_positionable <- function(p) is.numeric(p) && length(p) == 2

is_rangable <- function(r) is.numeric(r) && length(r) == 4

normalise_pos_or_range_arg <- function(location) {
    # This is necessary due to the loose constraints of the location argument
    # in rstudioapi::insertText and rstudioapi::modifyRange. These
    # functions can take single vectors coerable to postition or range OR a
    # list where each element may be a location, range, or a vector coercable
    # to such. I prefer to normalise the argument to a list of either formal
    # positions or ranges.
    if (rstudioapi::is.document_position(location)) {
        list(location)
    } else if (is_positionable(location)) {
        list(rstudioapi::as.document_position(location))
    } else if (rstudioapi::is.document_range(location)) {
        list(location)
    } else if (is_rangable(location)) {
        list(rstudioapi::as.document_range(location))
    } else if (is.list(location)) {
        lapply(
            location,
            function(a_location) {
                if (rstudioapi::is.document_position(a_location) || rstudioapi::is.document_range(a_location)) {
                    a_location
                } else if (is_positionable(a_location)) {
                    rstudioapi::as.document_position(a_location)
                } else if (is_rangable((a_location))) {
                    rstudioapi::as.document_range(a_location)
                } else {
                    stop(
                        "object in location list was not a",
                        " document_position or document_range"
                    )
                }
            }
        )
    } else {
        stop("location object was not a document_position or document_range")
    }
}

normalise_text_arg <- function(text, location_length) {
    if (length(text) == location_length) {
        text
    } else if (length(text) == 1 && location_length > 1) {
        rep(text, location_length)
    } else {
        stop(
            "text vector needs to be of length 1 or",
            " the same length as location list"
        )
    }
}

update_addin_registry <- function(addin_registry) {
    pkgs <- .packages(all.available = TRUE)
    addin_files <- vapply(pkgs, function(pkg) {
        system.file("rstudio/addins.dcf", package = pkg)
    }, character(1L))
    addin_files <- addin_files[file.exists(addin_files)]
    addin_descriptions <-
        mapply(
            function(package, package_dcf) {
                addin_description_names <-
                    c(
                        "name",
                        "description",
                        "binding",
                        "interactive",
                        "package"
                    )
                description_result <-
                    tryCatch({
                        addin_description <-
                            as.data.frame(read.dcf(package_dcf),
                                stringsAsFactors = FALSE
                            )

                        if (ncol(addin_description) < 4) {
                            NULL
                        }
                        ## if less than 4 columns it's malformed
                        ## a NULL will be ignored in the rbind

                        addin_description$package <- package
                        names(addin_description) <- addin_description_names

                        addin_description[, addin_description_names]
                        ## this filters out any extra columns
                    },
                    error = function(cond) {
                        message(
                            "addins.dcf file for ", package,
                            " could not be read from R library. ",
                            "The RStudio addin picker will not ",
                            "contain it's addins"
                        )

                        NULL
                    }
                    )

                description_result
            },
            names(addin_files),
            addin_files,
            SIMPLIFY = FALSE
        )
    addin_descriptions_flat <-
        do.call(
            function(...) rbind(..., make.row.names = FALSE),
            addin_descriptions
        )

    jsonlite::write_json(addin_descriptions_flat, addin_registry, pretty = TRUE)
}

namespace_has <- function(obj, namespace) {
    attempt <- try(getFromNamespace(obj, namespace), silent = TRUE)
    !inherits(attempt, "try-error")
}
