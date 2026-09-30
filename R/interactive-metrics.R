# This independent process supplies metrics even while the analysis R is busy.
if (!requireNamespace("systemfonts", quietly = TRUE)) stop("systemfonts is required for JGD metrics")
input <- file("stdin", "r")
repeat {
    line <- readLines(input, n = 1L, warn = FALSE)
    if (!length(line)) break
    request <- jsonlite::fromJSON(line, simplifyVector = FALSE)
    result <- tryCatch({
        font <- request$gc$font
        family <- if (is.null(font$family) || !nzchar(font$family)) "sans" else font$family
        size <- if (is.null(font$size)) 12 else font$size
        face <- if (is.null(font$face)) 1 else font$face
        text <- if (identical(request$kind, "strWidth")) request$str else intToUtf8(request$c)
        weight <- if (face %in% c(2, 4)) "bold" else "normal"
        width <- systemfonts::string_width(text, family = family, italic = face %in% c(3, 4),
                                           weight = weight, size = size, res = 72)
        info <- systemfonts::font_info(family = family, italic = face %in% c(3, 4),
                                       weight = weight, size = size, res = 72)
        list(type = "metrics_response", id = request$id, width = width[[1L]],
             ascent = info$max_ascend[[1L]], descent = abs(info$max_descend[[1L]]))
    }, error = function(e) {
        list(type = "metrics_error", id = request$id, message = conditionMessage(e))
    })
    cat(as.character(jsonlite::toJSON(result, auto_unbox = TRUE)), "\n", sep = "")
    flush(stdout())
}
