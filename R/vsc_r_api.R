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

rstudio_vsc_mapping <-
  list(
      getActiveDocumentContext = get_active_document_context
  )