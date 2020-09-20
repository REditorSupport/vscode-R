rstudioapi_patch_hook <- function(...) {
    patch_rstudioapi_fn <-
        function(old, new) {
            assignInNamespace(
                x = old,
                value = new,
                ns = "rstudioapi"
            )
        }
    mapply(
        patch_rstudioapi_fn,
        names(rstudio_vsc_mapping),
        rstudio_vsc_mapping
    )
}

get_active_document_context <- function() {
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

    ## insertText also supports insertText("text")
    ## allowing the location parameter to be used for the text when text itself is null
    ## this is dispatched as a separate request type
    if (missing(text) && missing(id) &&
        is.character(location) && length(location) == 1) {
        return(request("replace_text_in_current_selection", text = location))
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
                operation = if (rstudioapi::is.document_range(location)) "modifyRange" else "insertText",
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

rstudio_vsc_mapping <-
    list(
        getActiveDocumentContext = get_active_document_context,
        isAvailable = is_available,
        verifyAvailable = verify_available,
        insertText = insert_or_modify_text,
        modifyRange = insert_or_modify_text,
        readPreference = read_preference,
        readRStudioPreference = read_preference
    )