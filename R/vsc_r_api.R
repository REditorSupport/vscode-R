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


verify_available <- function(version_needed) {
    if (is.null(version_needed)) TRUE else FALSE
}

is_available <- function(version_needed, child_ok) {
    verify_available(version_needed)
}

insert_text <- function(location, text, id = NULL) {
  if (rstudioapi::is.document_range(location))
    return(modify_range(location, text, id))
  if (rstudioapi::is.document_position(location))
    return(insert_text_position(location, text, id))
  stop("location must be of class document_position or document_range")
}

insert_text_position <- function(location, text, id) {
  request("insert_text_at_position", text = text, id = id, position = location)
}
modify_range <- function(location, text, id = NULL) {
  NULL
}


rstudio_vsc_mapping <-
  list(
      getActiveDocumentContext = get_active_document_context,
      isAvailable = is_available,
      verifyAvailable = verify_available,
      insertText = insert_text
  )
