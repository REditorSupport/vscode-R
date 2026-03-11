getActiveDocumentContext <- function() {
    editor_context <- request_rstudioapi("active_editor_context", args = list())
    make_rs_document_context(editor_context)
}

getSourceEditorContext <- getActiveDocumentContext

verifyAvailable <- function(version_needed = NULL) {
    if (is.null(version_needed)) return(TRUE)
    getVersion() >= numeric_version(version_needed)
}

isAvailable <- function(version_needed = NULL, child_ok = FALSE) {
    verifyAvailable(version_needed)
}

insertText <- function(location, text, id = NULL) {
    if (missing(text) && is.character(location) && length(location) == 1) {
        return(invisible(request_rstudioapi("replace_text_in_current_selection", args = list(text = location, id = id))))
    } else if (missing(location)) {
        return(invisible(request_rstudioapi("replace_text_in_current_selection", args = list(text = text, id = id))))
    } else if (is.null(location) && missing(text)) {
        return(invisible(NULL))
    }

    normalised_location <- normalise_pos_or_range_arg(location)
    normalised_text <- normalise_text_arg(text, length(normalised_location))
    
    query <- mapply(function(location, text) {
        list(
            operation = if (rstudioapi::is.document_range(location)) "modifyRange" else "insertText",
            location = serialize_location(location),
            text = text
        )
    }, normalised_location, normalised_text, SIMPLIFY = FALSE)

    invisible(request_rstudioapi("insert_or_modify_text", args = list(query = query, id = id)))
}

modifyRange <- insertText

readPreference <- function(name, default) default
readRStudioPreference <- readPreference

.sess_rstudioapi_env <- environment()

hasFun <- function(name, version_needed = NULL, ...) {
    if (!is.null(version_needed)) {
        if (!verifyAvailable(version_needed)) return(FALSE)
    }
    obj <- .sess_rstudioapi_env[[name]]
    is.function(obj) && !identical(obj, .sess_not_yet_implemented)
}

findFun <- function(name, version_needed = NULL, ...) {
    if (!is.null(version_needed)) {
        if (!verifyAvailable(version_needed)) {
             stop("the generic IPC client does not support used of 'version_needed' > 0.")
        }
    }
    if (hasFun(name, version_needed = version_needed, ...)) {
        .sess_rstudioapi_env[[name]]
    } else {
        stop("Cannot find function '", name, "'")
    }
}

showDialog <- function(title, message, url = "") {
    message <- sprintf("%s: %s \n%s", title, message, url)
    invisible(request_rstudioapi("show_dialog", args = list(message = message)))
}

navigateToFile <- function(file, line = 1L, column = 1L) {
    invisible(request_rstudioapi("navigate_to_file", args = list(
        file = normalizePath(file), 
        line = line - 1L, 
        column = column - 1L
    )))
}

setSelectionRanges <- function(ranges, id = NULL) {
    ranges_or_positions <- normalise_pos_or_range_arg(ranges)
    ranges <- lapply(ranges_or_positions, function(location) {
        if (rstudioapi::is.document_position(location)) rstudioapi::document_range(location, location) else location
    })
    sess_ranges <- lapply(ranges, serialize_range)
    invisible(request_rstudioapi("set_selection_ranges", args = list(ranges = sess_ranges, id = id)))
}

setCursorPosition <- setSelectionRanges

documentSave <- function(id = NULL) invisible(request_rstudioapi("document_save", args = list(id = id)))

getActiveProject <- function() {
    path_object <- request_rstudioapi("get_project_path", args = list())
    path_object$path # Should be NULL if no project is open
}

.sess_document_context <- function(id = NULL) request_rstudioapi("document_context", args = list(id = id))

documentId <- function(allowConsole = TRUE) .sess_document_context()$id$external
documentPath <- function(id = NULL) .sess_document_context(id)$id$path

documentSaveAll <- function() invisible(request_rstudioapi("document_save_all", args = list()))

documentNew <- function(text = "", type = c("r", "rmarkdown", "sql"), position = rstudioapi::document_position(1, 1), execute = FALSE) {
    if (!rstudioapi::is.document_position((position))) stop("DocumentNew requires a document_position object")
    if (length(text) != 1 || !is.character(text)) stop("text for DocumentNew must be a length one character vector.")
    invisible(request_rstudioapi("document_new", args = list(text = text, type = match.arg(type), position = serialize_pos(position))))
}

setDocumentContents <- function(text, id = NULL) {
    whole_document_range <- rstudioapi::document_range(
        rstudioapi::document_position(1, 1),
        rstudioapi::document_position(Inf, Inf)
    )
    insertText(whole_document_range, text, id)
}

restartSession <- function() invisible(request_rstudioapi("restart_r", args = list()))

viewer <- function(url, height = NULL) {
    notify_client("webview", list(file = url, title = "Viewer"))
}

page_viewer <- function(url, title = NULL) {
    notify_client("browser", list(url = url, title = if (is.null(title)) "Page Viewer" else title))
}

getVersion <- function() numeric_version("0")

versionInfo <- function() list(citation = "", mode = "generic-ipc", version = numeric_version("0"), release_name = "generic-ipc")

sendToConsole <- function(code, execute = TRUE, echo = TRUE, focus = FALSE) {
    if (!echo) warning("rstudioapi::sendToConsole echo = FALSE is not supported in the generic IPC client.")
    code_to_run <- paste0(code, collapse = "\n")
    invisible(request_rstudioapi("send_to_console", args = list(code = code_to_run, execute = execute, focus = focus)))
}

documentClose <- function(id = NULL, save = TRUE) {
    invisible(request_rstudioapi("document_close", args = list(id = id, save = save)))
}

.sess_not_yet_implemented <- function(...) stop("This {rstudioapi} function is not currently implemented for generic IPC.")

# Add missing helpers from rstudioapi_util
make_rs_range <- function(sess_selection) {
    rstudioapi::document_range(
        start = rstudioapi::document_position(row = sess_selection$start$line + 1, column = sess_selection$start$character + 1),
        end = rstudioapi::document_position(row = sess_selection$end$line + 1, column = sess_selection$end$character + 1)
    )
}

extract_document_ranges <- function(sess_selections) lapply(sess_selections, make_rs_range)

to_content_lines <- function(contents, ranges) {
    content_lines <- strsplit(contents, "\n|\r\n|\r$")[[1]]
    if (length(ranges) == 0) return(content_lines)
    range_end_row <- unlist(lapply(ranges, function(range) range$end["row"]))
    last_row <- max(range_end_row)
    if (last_row == length(content_lines) + 1) content_lines <- c(content_lines, "")
    content_lines
}

extract_range_text <- function(range, content_lines) {
    if (!range_has_text(range)) return("")
    start_row <- range$start["row"]
    end_row <- range$end["row"]
    if (start_row > length(content_lines)) return("")
    
    content_rows <- content_lines[start_row:min(end_row, length(content_lines))]
    
    # Adjust end
    if (end_row <= length(content_lines)) {
        content_rows[length(content_rows)] <- substring(content_rows[length(content_rows)], 1, range$end["column"] - 1)
    }
    
    # Adjust start
    content_rows[1] <- substring(content_rows[1], range$start["column"])
    
    paste0(content_rows, collapse = "\n")
}

range_has_text <- function(range) (range$end["row"] - range$start["row"]) + (range$end["column"] - range$start["column"]) > 0

make_rs_document_selection <- function(ranges, range_texts) {
    mapply(function(range, text) {
        structure(list(range = range, text = text), class = "document_selection")
    }, ranges, range_texts, SIMPLIFY = FALSE)
}

make_rs_document_context <- function(sess_editor_context) {
    document_ranges <- extract_document_ranges(sess_editor_context$selection)
    content_lines <- to_content_lines(sess_editor_context$contents, document_ranges)
    document_range_texts <- lapply(document_ranges, extract_range_text, content_lines)
    document_selection <- make_rs_document_selection(document_ranges, document_range_texts)
    structure(list(
        id = sess_editor_context$id$external, 
        path = sess_editor_context$path, 
        contents = content_lines, 
        selection = document_selection
    ), class = "document_context")
}

is_positionable <- function(p) is.numeric(p) && length(p) == 2
is_rangable <- function(r) is.numeric(r) && length(r) == 4

normalise_pos_or_range_arg <- function(location) {
    if (rstudioapi::is.document_position(location)) {
        list(location)
    } else if (is_positionable(location)) {
        list(rstudioapi::as.document_position(location))
    } else if (rstudioapi::is.document_range(location)) {
        list(location)
    } else if (is_rangable(location)) {
        list(rstudioapi::as.document_range(location))
    } else if (is.list(location)) {
        lapply(location, function(a_location) {
            if (rstudioapi::is.document_position(a_location) || rstudioapi::is.document_range(a_location)) a_location
            else if (is_positionable(a_location)) rstudioapi::as.document_position(a_location)
            else if (is_rangable((a_location))) rstudioapi::as.document_range(a_location)
            else stop("object in location list was not a document_position or document_range")
        })
    } else stop("location object was not a document_position or document_range")
}

normalise_text_arg <- function(text, location_length) {
    if (length(text) == location_length) text
    else if (length(text) == 1 && location_length > 1) rep(text, location_length)
    else stop("text vector needs to be of length 1 or the same length as location list")
}

serialize_pos <- function(pos) {
    list(line = pos[["row"]] - 1, character = pos[["column"]] - 1)
}

serialize_range <- function(range) {
    list(start = serialize_pos(range$start), end = serialize_pos(range$end))
}

serialize_location <- function(location) {
    if (rstudioapi::is.document_position(location)) {
        serialize_pos(location)
    } else if (rstudioapi::is.document_range(location)) {
        serialize_range(location)
    } else {
        location
    }
}

namespace_has <- function(obj, namespace) {
    attempt <- try(getFromNamespace(obj, namespace), silent = TRUE)
    !inherits(attempt, "try-error")
}

patch_rstudioapi <- function() {
    overrides <- list(
        getActiveDocumentContext = getActiveDocumentContext,
        getSourceEditorContext = getSourceEditorContext,
        insertText = insertText,
        modifyRange = modifyRange,
        showDialog = showDialog,
        navigateToFile = navigateToFile,
        setSelectionRanges = setSelectionRanges,
        setCursorPosition = setCursorPosition,
        documentSave = documentSave,
        getActiveProject = getActiveProject,
        documentId = documentId,
        documentPath = documentPath,
        documentSaveAll = documentSaveAll,
        documentNew = documentNew,
        setDocumentContents = setDocumentContents,
        restartSession = restartSession,
        viewer = viewer,
        page_viewer = page_viewer,
        getVersion = getVersion,
        versionInfo = versionInfo,
        sendToConsole = sendToConsole,
        documentClose = documentClose,
        hasFun = hasFun,
        findFun = findFun,
        isAvailable = isAvailable,
        verifyAvailable = verifyAvailable,
        readPreference = readPreference,
        readRStudioPreference = readRStudioPreference,
        
        getConsoleEditorContext = .sess_not_yet_implemented,
        sourceMarkers = .sess_not_yet_implemented,
        showPrompt = .sess_not_yet_implemented,
        showQuestion = .sess_not_yet_implemented,
        updateDialog = .sess_not_yet_implemented,
        openProject = .sess_not_yet_implemented,
        initializeProject = .sess_not_yet_implemented,
        addTheme = .sess_not_yet_implemented,
        applyTheme = .sess_not_yet_implemented,
        convertTheme = .sess_not_yet_implemented,
        getThemeInfo = .sess_not_yet_implemented,
        getThemes = .sess_not_yet_implemented,
        removeTheme = .sess_not_yet_implemented,
        jobAdd = .sess_not_yet_implemented,
        jobAddOutput = .sess_not_yet_implemented,
        jobAddProgress = .sess_not_yet_implemented,
        jobRemove = .sess_not_yet_implemented,
        jobRunScript = .sess_not_yet_implemented,
        jobSetProgress = .sess_not_yet_implemented,
        jobSetState = .sess_not_yet_implemented,
        jobSetStatus = .sess_not_yet_implemented,
        launcherGetInfo = .sess_not_yet_implemented,
        launcherAvailable = .sess_not_yet_implemented,
        launcherGetJobs = .sess_not_yet_implemented,
        launcherConfig = .sess_not_yet_implemented,
        launcherContainer = .sess_not_yet_implemented,
        launcherControlJob = .sess_not_yet_implemented,
        launcherGetJob = .sess_not_yet_implemented,
        launcherHostMount = .sess_not_yet_implemented,
        launcherNfsMount = .sess_not_yet_implemented,
        launcherPlacementConstraint = .sess_not_yet_implemented,
        launcherResourceLimit = .sess_not_yet_implemented,
        launcherSubmitJob = .sess_not_yet_implemented,
        launcherSubmitR = .sess_not_yet_implemented,
        previewRd = .sess_not_yet_implemented,
        previewSql = .sess_not_yet_implemented,
        writePreference = .sess_not_yet_implemented,
        writeRStudioPreference = .sess_not_yet_implemented,
        getPersistentValue = .sess_not_yet_implemented,
        setPersistentValue = .sess_not_yet_implemented,
        savePlotAsImage = .sess_not_yet_implemented,
        createProjectTemplate = .sess_not_yet_implemented,
        hasColourConsole = .sess_not_yet_implemented,
        bugReport = .sess_not_yet_implemented,
        buildToolsCheck = .sess_not_yet_implemented,
        buildToolsInstall = .sess_not_yet_implemented,
        buildToolsExec = .sess_not_yet_implemented,
        dictionariesPath = .sess_not_yet_implemented,
        userDictionariesPath = .sess_not_yet_implemented,
        executeCommand = .sess_not_yet_implemented,
        translateLocalUrl = .sess_not_yet_implemented
    )

    for (name in names(overrides)) {
        if (exists(name, envir = asNamespace("rstudioapi"), inherits = FALSE)) {
            rebind(name, overrides[[name]], "rstudioapi")
        }
    }
}
