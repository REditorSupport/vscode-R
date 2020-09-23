rstudioapi_patch_hook <- function(...) {
    patch_rstudioapi_fn <-
        function(old, new) {
            assignInNamespace(
                x = old,
                value = new,
                ns = "rstudioapi"
            )
        }
    ## create mappings for functions with implementations
    mapply(
        patch_rstudioapi_fn,
        names(rstudio_vsc_mapping),
        rstudio_vsc_mapping
    )
    ## create mapping to not implemented error functions without
    ## implementations
    lapply(
        rstudio_vsc_no_map,
        patch_rstudioapi_fn,
        new = not_yet_implemented
    )
}

not_yet_implemented <- function(...) {
    stop("This {rstudioapi} function is not currently implemented for VSCode.")
}

get_active_document_context <- function() {
    # In RStudio this returns either a document context for either the active
    # source editor or active console. 
    # In VSCode this only ever returns the active (or last active) text editor.
    # This is because it is currently not possible to tell in VSCode whether
    # a text editor or terminal has focus. The concept of active is different.
    # It means currently using or most recently used, and applies to text
    # editors and terminals separately.
    # This shoudln't be much of a limitation as the only context returned for
    # the console was the current selection, so it is not very useful.
    editor_context <- request_response("active_editor_context")

    make_rs_document_context(editor_context)
}


verify_available <- function(version_needed = NULL) {
    if (is.null(version_needed)) TRUE else FALSE
}

is_available <- function(version_needed = NULL, child_ok) {
    verify_available(version_needed)
}

insert_or_modify_text <- function(location, text, id = NULL) {

    ## insertText also supports insertText("text"), insertText(text = "text"), 
    ## allowing the location parameter to be used for the text when
    ## text itself is null.
    ## This is dispatched as a separate request type
    if (missing(text) && is.character(location) && length(location) == 1) {
        ## handling insertText("text")
        return(request("replace_text_in_current_selection", text = location, id = id))
    } else if (missing(location)) {
        ## handling insertText(text = "text")
        return(request("replace_text_in_current_selection", text = text, id = id))
    } else if (is.null(location) && missing(text)) {
        ## handling insertText(NULL)
        return(invisible(NULL))
    }

    ## ensure normalised_location is a list containing a possible mix of
    ## document_position and document_range objects
    normalised_location <- normalise_position_or_range_arg(location)
    normalised_text <- normalise_text_arg(text, length(normalised_location))
    ## Having normalised we are guaranteed these are the same length.
    ## Package up all the edits in a query to send to VSCode in an object
    ## This is done so the edits can be applied in a single edit object, which
    ## is hopefull closest to RStudio behaviour.
    query <-
        mapply(function(location, text) {
            list(
                operation = if (rstudioapi::is.document_range(location)) {
                    "modifyRange"
                } else {
                    "insertText"
                },
                location = location,
                text = text
            )
        },
        normalised_location,
        normalised_text,
        SIMPLIFY = FALSE
        )

    request("insert_or_modify_text", query = query, id = id)
}

read_preference <- function(name, default) {
    ## in future we could map some rstudio preferences to vscode settings.
    ## since the caller must provide a default this should work.
    default
}

has_fun <- function(name, version_needed = NULL, ...) {
    if (!is.null(version_needed)) return(FALSE)

    exists(x = name, envir = as.environment(rstudio_vsc_mapping), ...)
}

get_fun <- function(name, version_needed = NULL, ...) {
    if (!is.null(version_needed)) return(FALSE)

    get(x = name, envir = as.environment(rstudio_vsc_mapping), ...)
}

rstudio_vsc_mapping <-
    list(
        getActiveDocumentContext = get_active_document_context,
        getSourceEditorContext = get_active_document_context,
        isAvailable = is_available,
        verifyAvailable = verify_available,
        insertText = insert_or_modify_text,
        modifyRange = insert_or_modify_text,
        readPreference = read_preference,
        readRStudioPreference = read_preference,
        hasFun = has_fun,
        findFun = get_fun
    )

rstudio_vsc_no_map <- 
    list(
        "getConsoleEditorContext"
    )