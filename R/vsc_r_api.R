rstudioapi_patch_hook <- function(...) {
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
        return(request("replace_text_in_current_selection",
            text = location,
            id = id
        ))
    } else if (missing(location)) {
        ## handling insertText(text = "text")
        return(request("replace_text_in_current_selection",
            text = text,
            id = id
        ))
    } else if (is.null(location) && missing(text)) {
        ## handling insertText(NULL)
        return(invisible(NULL))
    }

    ## ensure normalised_location is a list containing a possible mix of
    ## document_position and document_range objects
    normalised_location <- normalise_pos_or_range_arg(location)
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

    invisible(
        request_response("insert_or_modify_text", query = query, id = id)
    )
}

read_preference <- function(name, default) {
    ## in future we could map some rstudio preferences to vscode settings.
    ## since the caller must provide a default this should work.
    default
}

has_fun <- function(name, version_needed = NULL, ...) {
    if (!is.null(version_needed)) {
        return(FALSE)
    }

    exists(x = name, envir = as.environment(rstudio_vsc_mapping), ...)
}

get_fun <- function(name, version_needed = NULL, ...) {
    if (!is.null(version_needed)) {
        stop("VSCode does not support used of 'version_needed'.")
    }

    get(x = name, envir = as.environment(rstudio_vsc_mapping), ...)
}

show_dialog <- function(title, message, url = "") {
    message <- sprintf("%s: %s \n%s", title, message, url)
    invisible(
        request_response("show_dialog", message = message)
    )
}

navigate_to_file <- function(file, line = -1L, column = -1L) {
    # normalise path since relative paths don't work as URIs in VSC
    invisible(
        request_response(
            "navigate_to_file",
            file = normalizePath(file),
            line = line,
            column = column
        )
    )
}

set_selection_ranges <- function(ranges, id = NULL) {
    ranges <- normalise_pos_or_range_arg(ranges)
    are_ranges <- unlist(lapply(ranges, rstudioapi::is.document_range))
    if (!all(are_ranges)) {
        stop("Expecting only document_range objects. Got something else.")
    }
    invisible(
        request_response("set_selection_ranges", ranges = ranges, id = id)
    )
}

set_cursor_position <- function(position, id = NULL) {
    position <- normalise_pos_or_range_arg(position)
    if (length(position) > 1) {
        stop("setCursorPosition takes a single document_position object")
    }
    if (!rstudioapi::is.document_position(position[[1]])) {
        stop("Expecting a document_position object. Got something else.")
    }

    invisible(
        ## have to wrap in list() to make sure it's an array of arrays on the
        # other end.
        request_response("set_selection_ranges",
            ranges = list(rstudioapi::document_range(
                position[[1]],
                position[[1]]
            )),
            id = id
        )
    )
}

document_save <- function(id = NULL) {
    invisible(
        request_response("document_save", id = id)
    )
}

get_active_project <- function() {
    path_object <- request_response("get_project_path")
    if (is.null(path_object$path)) {
        stop(
            "No folder for active document. ",
            "Is it unsaved? Try saving and run addin again."
        )
    }
    path_object$path
}

document_context <- function(id = NULL) {
    doc_context <- request_response("document_context", id = id)
    doc_context
}

document_id <- function(allowConsole = TRUE) document_context()$id$external

document_path <- function(id = NULL) document_context(id)$id$path

document_save_all <- function() {
    invisible(
        request_response("document_save_all")
    )
}

document_new <- function(text,
                         type = c("r", "rmarkdown", "sql"),
                         position = rstudioapi::document_position(0, 0),
                         execute = FALSE) {
    if (!rstudioapi::is.document_position((position))) {
        stop("DocumentNew requires a document_position object")
    }
    if (length(text) != 1 || !is.character(text)) {
        stop("text for DocumentNew must be a length one character vector.")
    }
    if (execute) {
        message("VSCode {rstudioapi} emulation does not support ",
                " executing documents upon creation")
    }

    invisible(
        request_response(
            "document_new",
            text = text,
            type = type,
            position = position
        )
    )
}

restart_r_session <- function() {
    invisible(
        request_response("restart_r")
    )
}

vsc_viewer <- function(url, height = NULL) {
    # cant bind to this directly because it's not created when the bidning is
    # made.
    .vsc.viewer(url)
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
        findFun = get_fun,
        showDialog = show_dialog,
        navigateToFile = navigate_to_file,
        setSelectionRanges = set_selection_ranges,
        setCursorPosition = set_cursor_position,
        documentSave = document_save,
        documentId = document_id,
        documentPath = document_path,
        documentSaveAll = document_save_all,
        documentNew = document_new,
        getActiveProject = get_active_project,
        restartSession = restart_r_session,
        viewer = vsc_viewer
    )

rstudio_vsc_no_map <-
    list(
        "getConsoleEditorContext",
        "sourceMarkers",
        "versionInfo",
        "getVersion",
        "documentClose",
        "sendToConsole",
        "showPrompt",
        "showQuestion",
        "updateDialog",
        "openProject",
        "initializeProject",
        "addTheme",
        "applyTheme",
        "convertTheme",
        "getThemeInfo",
        "getThemes",
        "removeTheme",
        "jobAdd",
        "jobAddOutput",
        "jobAddProgress",
        "jobRemove",
        "jobRunScript",
        "jobSetProgress",
        "jobSetState",
        "jobSetStatus",
        "launcherGetInfo",
        "launcherAvailable",
        "launcherGetJobs",
        "launcherConfig",
        "launcherContainer",
        "launcherControlJob",
        "launcherGetJob",
        "launcherHostMount",
        "launcherNfsMount",
        "launcherPlacementConstraint",
        "launcherResourceLimit",
        "launcherSubmitJob",
        "launcherSubmitR",
        "previewRd",
        "previewSql",
        "writePreference",
        "writeRStudioPreference",
        "getPersistentValue",
        "setPersistentValue",
        "savePlotAsImage",
        "createProjectTemplate",
        "hasColourConsole",
        "bugReport",
        "buildToolsCheck",
        "buildToolsInstall",
        "buildToolsExec",
        "dictionariesPath",
        "userDictionariesPath",
        "executeCommand",
        "translateLocalUrl"
    )