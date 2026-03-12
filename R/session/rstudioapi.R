getActiveDocumentContext <- function() {
    # In RStudio this returns either a document context for either the active
    # source editor or active console.
    # In VSCode this only ever returns the active (or last active) text editor.
    # This is because it is currently not possible to tell in VSCode whether
    # a text editor or terminal has focus. The concept of active is different.
    # It means currently using or most recently used, and applies to text
    # editors and terminals separately.
    # This shoudln't be much of a limitation as the only context returned for
    # the console was the current selection, so it is not very useful.
    editor_context <- rstudioapi_call("active_editor_context")

    make_rs_document_context(editor_context)
}

getSourceEditorContext <- getActiveDocumentContext

verifyAvailable <- function(version_needed = NULL) {
    if (is.null(version_needed)) TRUE else FALSE
}

isAvailable <- function(version_needed = NULL, child_ok) {
    verifyAvailable(version_needed)
}

insertText <- function(location, text, id = NULL) {

    ## insertText also supports insertText("text"), insertText(text = "text"),
    ## allowing the location parameter to be used for the text when
    ## text itself is null.
    ## This is dispatched as a separate request type
    if (missing(text) && is.character(location) && length(location) == 1) {
        ## handling insertText("text")
        return(invisible(
            rstudioapi_call("replace_text_in_current_selection",
                text = location,
                id = id
            )
        ))
    } else if (missing(location)) {
        ## handling insertText(text = "text")
        return(invisible(rstudioapi_call(
            "replace_text_in_current_selection",
            text = text,
            id = id
        )))
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
        rstudioapi_call("insert_or_modify_text", query = query, id = id)
    )
}

modifyRange <- insertText

readPreference <- function(name, default) {
    ## in future we could map some rstudio preferences to vscode settings.
    ## since the caller must provide a default this should work.
    default
}

readRStudioPreference <- readPreference

.vsc_rstudioapi_env <- environment()

hasFun <- function(name, version_needed = NULL, ...) {
    if (!is.null(version_needed)) {
        return(FALSE)
    }

    obj <- .vsc_rstudioapi_env[[name]]
    is.function(obj) && !identical(obj, .vsc_not_yet_implemented)
}

findFun <- function(name, version_needed = NULL, ...) {
    if (!is.null(version_needed)) {
        stop("VSCode does not support used of 'version_needed'.")
    }

    if (hasFun(name, version_needed = version_needed, ...)) {
        .vsc_rstudioapi_env[[name]]
    } else {
        stop("Cannot find function '", name, "'")
    }
}

showDialog <- function(title, message, url = "") {
    message <- sprintf("%s: %s \n%s", title, message, url)
    invisible(
        rstudioapi_call("show_dialog", message = message)
    )
}

navigateToFile <- function(file, line = -1L, column = -1L) {
    # normalise path since relative paths don't work as URIs in VSC
    invisible(
        rstudioapi_call(
            "navigate_to_file",
            file = normalizePath(file),
            line = line,
            column = column
        )
    )
}

setSelectionRanges <- function(ranges, id = NULL) {
    ranges_or_positions <- normalise_pos_or_range_arg(ranges)

    ranges <- lapply(ranges_or_positions, function(location) {
        if (rstudioapi::is.document_position(location)) {
            rstudioapi::document_range(location, location)
        } else {
            location
        }
    })

    invisible(
        rstudioapi_call("set_selection_ranges", ranges = ranges, id = id)
    )
}

setCursorPosition <- setSelectionRanges

documentSave <- function(id = NULL) {
    invisible(
        rstudioapi_call("document_save", id = id)
    )
}

getActiveProject <- function() {
    path_object <- rstudioapi_call("get_project_path")
    if (is.null(path_object$path)) {
        stop(
            "No folder for active document. ",
            "Is it unsaved? Try saving and run addin again."
        )
    }
    path_object$path
}

.vsc_document_context <- function(id = NULL) {
    doc_context <- rstudioapi_call("document_context", id = id)
    doc_context
}

documentId <- function(allowConsole = TRUE) document_context()$id$external

documentPath <- function(id = NULL) document_context(id)$id$path

documentSaveAll <- function() {
    invisible(
        rstudioapi_call("document_save_all")
    )
}

documentNew <- function(text,
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
        message(
            "VSCode {rstudioapi} emulation does not support ",
            " executing documents upon creation"
        )
    }

    invisible(
        rstudioapi_call(
            "document_new",
            text = text,
            type = type,
            position = position
        )
    )
}

setDocumentContents <- function(text, id = NULL) {
    whole_document_range <-
        rstudioapi::document_range(
            rstudioapi::document_position(0, 0),
            rstudioapi::document_position(Inf, Inf)
        )
    insertText(whole_document_range, text, id)
}

restartSession <- function() {
    invisible(
        rstudioapi_call("restart_r")
    )
}

viewer <- function(url, height = NULL) {
    # cant bind to this directly because it's not created when the binding is
    # made.
    .vsc.viewer(url)
}

getVersion <- function() {
    numeric_version("0")
}

versionInfo <- function() {
    list(
        citation = "",
        mode = "vscode",
        version = numeric_version("0"),
        release_name = "vscode"
    )
}

sendToConsole <- function(code, execute = TRUE, echo = TRUE, focus = FALSE) {
    if (!echo) {
        stop("rstudioapi::sendToConsole only supports echo = TRUE in VSCode.")
    }

    code_to_run <- paste0(code, collapse = "\n")
    invisible(
        rstudioapi_call("send_to_console", code = code_to_run, execute = execute, focus = focus)
    )
}


# Unimplemented API calls that will error if called.

.vsc_not_yet_implemented <- function(...) {
    stop("This {rstudioapi} function is not currently implemented for VSCode.")
}


getConsoleEditorContext <- .vsc_not_yet_implemented
sourceMarkers <- .vsc_not_yet_implemented
documentClose <- .vsc_not_yet_implemented
showPrompt <- .vsc_not_yet_implemented
showQuestion <- .vsc_not_yet_implemented
updateDialog <- .vsc_not_yet_implemented
openProject <- .vsc_not_yet_implemented
initializeProject <- .vsc_not_yet_implemented
addTheme <- .vsc_not_yet_implemented
applyTheme <- .vsc_not_yet_implemented
convertTheme <- .vsc_not_yet_implemented
getThemeInfo <- .vsc_not_yet_implemented
getThemes <- .vsc_not_yet_implemented
removeTheme <- .vsc_not_yet_implemented
jobAdd <- .vsc_not_yet_implemented
jobAddOutput <- .vsc_not_yet_implemented
jobAddProgress <- .vsc_not_yet_implemented
jobRemove <- .vsc_not_yet_implemented
jobRunScript <- .vsc_not_yet_implemented
jobSetProgress <- .vsc_not_yet_implemented
jobSetState <- .vsc_not_yet_implemented
jobSetStatus <- .vsc_not_yet_implemented
launcherGetInfo <- .vsc_not_yet_implemented
launcherAvailable <- .vsc_not_yet_implemented
launcherGetJobs <- .vsc_not_yet_implemented
launcherConfig <- .vsc_not_yet_implemented
launcherContainer <- .vsc_not_yet_implemented
launcherControlJob <- .vsc_not_yet_implemented
launcherGetJob <- .vsc_not_yet_implemented
launcherHostMount <- .vsc_not_yet_implemented
launcherNfsMount <- .vsc_not_yet_implemented
launcherPlacementConstraint <- .vsc_not_yet_implemented
launcherResourceLimit <- .vsc_not_yet_implemented
launcherSubmitJob <- .vsc_not_yet_implemented
launcherSubmitR <- .vsc_not_yet_implemented
previewRd <- .vsc_not_yet_implemented
previewSql <- .vsc_not_yet_implemented
writePreference <- .vsc_not_yet_implemented
writeRStudioPreference <- .vsc_not_yet_implemented
getPersistentValue <- .vsc_not_yet_implemented
setPersistentValue <- .vsc_not_yet_implemented
savePlotAsImage <- .vsc_not_yet_implemented
createProjectTemplate <- .vsc_not_yet_implemented
hasColourConsole <- .vsc_not_yet_implemented
bugReport <- .vsc_not_yet_implemented
buildToolsCheck <- .vsc_not_yet_implemented
buildToolsInstall <- .vsc_not_yet_implemented
buildToolsExec <- .vsc_not_yet_implemented
dictionariesPath <- .vsc_not_yet_implemented
userDictionariesPath <- .vsc_not_yet_implemented
executeCommand <- .vsc_not_yet_implemented
translateLocalUrl <- .vsc_not_yet_implemented
