pid <- Sys.getpid()
wd <- getwd()
tempdir <- tempdir()
homedir <- Sys.getenv(
    if (.Platform$OS.type == "windows") "USERPROFILE" else "HOME"
)
dir_watcher <- Sys.getenv("VSCODE_WATCHER_DIR", file.path(homedir, ".vscode-R"))
request_file <- file.path(dir_watcher, "request.log")
request_lock_file <- file.path(dir_watcher, "request.lock")
settings_file <- file.path(dir_watcher, "settings.json")
user_options <- names(options())

logger <- if (getOption("vsc.debug", FALSE)) {
    function(...) cat(..., "\n", sep = "")
} else {
    function(...) invisible()
}

load_settings <- function() {
    if (!file.exists(settings_file)) {
        return(FALSE)
    }

    setting <- function(x, ...) {
        switch(EXPR = x, ..., x)
    }

    mapping <- quote(list(
        vsc.use_webserver = session$useWebServer,
        vsc.use_httpgd = plot$useHttpgd,
        vsc.show_object_size = workspaceViewer$showObjectSize,
        vsc.rstudioapi = session$emulateRStudioAPI,
        vsc.str.max.level = setting(session$levelOfObjectDetail, Minimal = 0, Normal = 1, Detailed = 2),
        vsc.object_length_limit = session$objectLengthLimit,
        vsc.object_timeout = session$objectTimeout,
        vsc.globalenv = session$watchGlobalEnvironment,
        vsc.plot = setting(session$viewers$viewColumn$plot, Disable = FALSE),
        vsc.dev.args = plot$devArgs,
        vsc.browser = setting(session$viewers$viewColumn$browser, Disable = FALSE),
        vsc.viewer = setting(session$viewers$viewColumn$viewer, Disable = FALSE),
        vsc.page_viewer = setting(session$viewers$viewColumn$pageViewer, Disable = FALSE),
        vsc.row_limit = session$data$rowLimit,
        vsc.view = setting(session$viewers$viewColumn$view, Disable = FALSE),
        vsc.helpPanel = setting(session$viewers$viewColumn$helpPanel, Disable = FALSE)
    ))

    vsc_settings <- tryCatch(jsonlite::read_json(settings_file), error = function(e) {
        message("Error occurs when reading VS Code settings: ", conditionMessage(e))
    })

    if (is.null(vsc_settings)) {
        return(FALSE)
    }

    ops <- eval(mapping, vsc_settings)

    # exclude options set by user on startup
    r_options <- ops[!(names(ops) %in% user_options)]

    options(r_options)
}

load_settings()

if (is.null(getOption("help_type"))) {
    options(help_type = "html")
}

use_webserver <- isTRUE(getOption("vsc.use_webserver", FALSE))
if (use_webserver) {
    if (requireNamespace("httpuv", quietly = TRUE)) {
        request_handlers <- list(
            hover = function(expr, ...) {
                tryCatch({
                    expr <- parse(text = expr, keep.source = FALSE)[[1]]
                    obj <- eval(expr, .GlobalEnv)
                    list(str = capture_str(obj))
                }, error = function(e) NULL)
            },

            complete = function(expr, trigger, ...) {
                obj <- tryCatch({
                    expr <- parse(text = expr, keep.source = FALSE)[[1]]
                    eval(expr, .GlobalEnv)
                }, error = function(e) NULL)

                if (is.null(obj)) {
                    return(NULL)
                }

                if (trigger == "$") {
                    names <- if (is.object(obj)) {
                        .DollarNames(obj, pattern = "")
                    } else if (is.recursive(obj)) {
                        names(obj)
                    } else {
                        NULL
                    }

                    result <- lapply(names, function(name) {
                        item <- obj[[name]]
                        list(
                            name = name,
                            type = typeof(item),
                            str = try_capture_str(item)
                        )
                    })
                    return(result)
                }

                if (trigger == "@" && isS4(obj)) {
                    names <- slotNames(obj)
                    result <- lapply(names, function(name) {
                        item <- slot(obj, name)
                        list(
                            name = name,
                            type = typeof(item),
                            str = try_capture_str(item)
                        )
                    })
                    return(result)
                }
            }
        )

        server <- getOption("vsc.server")
        if (!is.null(server) && server$isRunning()) {
            host <- server$getHost()
            port <- server$getPort()
            token <- attr(server, "token")
        } else {
            host <- "127.0.0.1"
            port <- httpuv::randomPort()
            token <- sprintf("%d:%d:%.6f", pid, port, Sys.time())
            server <- httpuv::startServer(host, port,
                list(
                    onHeaders = function(req) {
                        logger("http request ",
                            req[["REMOTE_ADDR"]], ":",
                            req[["REMOTE_PORT"]], " ",
                            req[["REQUEST_METHOD"]], " ",
                            req[["HTTP_USER_AGENT"]]
                        )

                        if (!nzchar(req[["REMOTE_ADDR"]]) || identical(req[["REMOTE_PORT"]], "0")) {
                            return(NULL)
                        }

                        if (!identical(req[["HTTP_AUTHORIZATION"]], token)) {
                            return(list(
                                status = 401L,
                                headers = list(
                                    "Content-Type" = "text/plain"
                                ),
                                body = "Unauthorized"
                            ))
                        }

                        if (!identical(req[["HTTP_CONTENT_TYPE"]], "application/json")) {
                            return(list(
                                status = 400L,
                                headers = list(
                                    "Content-Type" = "text/plain"
                                ),
                                body = "Bad request"
                            ))
                        }
                    },
                    call = function(req) {
                        content <- req$rook.input$read_lines()
                        request <- jsonlite::fromJSON(content, simplifyVector = FALSE)
                        handler <- request_handlers[[request$type]]
                        response <- if (is.function(handler)) do.call(handler, request)

                        list(
                            status = 200L,
                            headers = list(
                                "Content-Type" = "application/json"
                            ),
                            body = jsonlite::toJSON(response, auto_unbox = TRUE, force = TRUE)
                        )
                    }
                )
            )
            attr(server, "token") <- token
            options(vsc.server = server)
        }
    } else {
        message("{httpuv} is required to use WebServer from the session watcher.")
        use_webserver <- FALSE
    }
}

get_timestamp <- function() {
    sprintf("%.6f", Sys.time())
}

scalar <- function(x) {
    class(x) <- c("scalar", class(x))
    x
}

request <- function(command, ...) {
    obj <- list(
        time = Sys.time(),
        pid = pid,
        wd = wd,
        command = command,
        ...
    )
    jsonlite::write_json(obj, request_file,
        auto_unbox = TRUE, null = "null", force = TRUE
    )
    cat(get_timestamp(), file = request_lock_file)
}

try_catch_timeout <- function(expr, timeout = Inf, ...) {
    expr <- substitute(expr)
    envir <- parent.frame()
    setTimeLimit(timeout, transient = TRUE)
    on.exit(setTimeLimit())
    tryCatch(eval(expr, envir), ...)
}

capture_str <- function(object, max.level = getOption("vsc.str.max.level", 0)) {
    paste0(utils::capture.output(
        utils::str(object,
            max.level = max.level,
            give.attr = FALSE,
            vec.len = 1
        )
    ), collapse = "\n")
}

try_capture_str <- function(object, max.level = getOption("vsc.str.max.level", 0)) {
    tryCatch(
        capture_str(object, max.level = max.level),
        error = function(e) {
            paste0(class(object), collapse = ", ")
        }
    )
}

rebind <- function(sym, value, ns) {
    if (is.character(ns)) {
        Recall(sym, value, getNamespace(ns))
        pkg <- paste0("package:", ns)
        if (pkg %in% search()) {
            Recall(sym, value, as.environment(pkg))
        }
    } else if (is.environment(ns)) {
        if (bindingIsLocked(sym, ns)) {
            unlockBinding(sym, ns)
            on.exit(lockBinding(sym, ns))
        }
        assign(sym, value, ns)
    } else {
        stop("ns must be a string or environment")
    }
}

address <- function(x) {
    info <- utils::capture.output(.Internal(inspect(x, 0L, 0L)))
    sub("@([a-z0-9]+)\\s+.+", "\\1", info[[1]])
}

globalenv_cache <- new.env(parent = emptyenv())

inspect_env <- function(env, cache) {
    all_names <- ls(env)
    rm(list = setdiff(names(globalenv_cache), all_names), envir = cache)
    is_active <- vapply(all_names, bindingIsActive, logical(1), USE.NAMES = TRUE, env)
    is_promise <- rlang::env_binding_are_lazy(env, all_names[!is_active])
    show_object_size <- getOption("vsc.show_object_size", FALSE)
    object_length_limit <- getOption("vsc.object_length_limit", 2000)
    object_timeout <- getOption("vsc.object_timeout", 50) / 1000
    str_max_level <- getOption("vsc.str.max.level", 0)
    objs <- lapply(all_names, function(name) {
        if (isTRUE(is_promise[name])) {
            info <- list(
                class = "promise",
                type = scalar("promise"),
                length = scalar(0L),
                str = scalar("(promise)")
            )
        } else if (isTRUE(is_active[name])) {
            info <- list(
                class = "active_binding",
                type = scalar("active_binding"),
                length = scalar(0L),
                str = scalar("(active-binding)")
            )
        } else {
            obj <- env[[name]]

            info <- list(
                class = class(obj),
                type = scalar(typeof(obj)),
                length = scalar(length(obj))
            )

            if (show_object_size) {
                addr <- address(obj)
                cobj <- cache[[name]]
                if (is.null(cobj) || cobj$address != addr || cobj$length != info$length) {
                    cache[[name]] <- cobj <- list(
                        address = addr,
                        length = length(obj),
                        size = unclass(object.size(obj))
                    )
                }
                info$size <- scalar(cobj$size)
            }

            if (length(obj) > object_length_limit) {
                info$str <- scalar(trimws(try_capture_str(obj, 0)))
            } else {
                info_str <- NULL
                if (str_max_level > 0) {
                    info_str <- try_catch_timeout(
                        capture_str(obj, str_max_level),
                        timeout = object_timeout,
                        error = function(e) NULL
                    )
                }
                if (is.null(info_str)) {
                    info_str <- try_capture_str(obj, 0)
                }
                info$str <- scalar(trimws(info_str))
                obj_names <- if (is.object(obj)) {
                    .DollarNames(obj, pattern = "")
                } else if (is.recursive(obj)) {
                    names(obj)
                } else {
                    NULL
                }

                if (length(obj_names)) {
                    info$names <- obj_names
                }
            }

            if (isS4(obj)) {
                info$slots <- slotNames(obj)
            }

            if (!is.null(dim(obj))) {
                info$dim <- dim(obj)
            }
        }
        info
    })
    names(objs) <- all_names
    objs
}

dir_session <- file.path(tempdir, "vscode-R")
dir.create(dir_session, showWarnings = FALSE, recursive = TRUE)

removeTaskCallback("vsc.workspace")
show_globalenv <- isTRUE(getOption("vsc.globalenv", TRUE))
workspace_file <- file.path(dir_session, "workspace.json")
workspace_lock_file <- file.path(dir_session, "workspace.lock")
file.create(workspace_lock_file, showWarnings = FALSE)

update_workspace <- function(...) {
    tryCatch({
        data <- list(
            search = search()[-1],
            loaded_namespaces = loadedNamespaces(),
            globalenv = if (show_globalenv) inspect_env(.GlobalEnv, globalenv_cache) else NULL
        )
        jsonlite::write_json(data, workspace_file, force = TRUE, pretty = FALSE)
        cat(get_timestamp(), file = workspace_lock_file)
    }, error = message)
    TRUE
}
update_workspace()
addTaskCallback(update_workspace, name = "vsc.workspace")

removeTaskCallback("vsc.plot")
use_httpgd <- identical(getOption("vsc.use_httpgd", FALSE), TRUE)
show_plot <- !identical(getOption("vsc.plot", "Two"), FALSE)
if (use_httpgd && "httpgd" %in% .packages(all.available = TRUE)) {
    options(device = function(...) {
        httpgd::hgd(
            silent = TRUE
        )
        .vsc$request("httpgd", url = httpgd::hgd_url())
    })
} else if (use_httpgd) {
    message("Install package `httpgd` to use vscode-R with httpgd!")
} else if (show_plot) {
    plot_file <- file.path(dir_session, "plot.png")
    plot_lock_file <- file.path(dir_session, "plot.lock")
    file.create(plot_file, plot_lock_file, showWarnings = FALSE)

    plot_updated <- FALSE
    null_dev_id <- c(pdf = 2L)
    null_dev_size <- c(7 + pi, 7 + pi)

    check_null_dev <- function() {
        identical(dev.cur(), null_dev_id) &&
            identical(dev.size(), null_dev_size)
    }

    new_plot <- function() {
        if (check_null_dev()) {
            plot_updated <<- TRUE
        }
    }

    options(
        device = function(...) {
            pdf(NULL,
                width = null_dev_size[[1L]],
                height = null_dev_size[[2L]],
                bg = "white")
            dev.control(displaylist = "enable")
        }
    )

    update_plot <- function(...) {
        tryCatch({
            if (plot_updated && check_null_dev()) {
                plot_updated <<- FALSE
                record <- recordPlot()
                if (length(record[[1L]])) {
                    dev_args <- getOption("vsc.dev.args")
                    do.call(png, c(list(filename = plot_file), dev_args))
                    on.exit({
                        dev.off()
                        cat(get_timestamp(), file = plot_lock_file)
                    })
                    replayPlot(record)
                }
            }
        }, error = message)
        TRUE
    }

    setHook("plot.new", new_plot, "replace")
    setHook("grid.newpage", new_plot, "replace")

    rebind(".External.graphics", function(...) {
        out <- .Primitive(".External.graphics")(...)
        if (check_null_dev()) {
            plot_updated <<- TRUE
        }
        out
    }, "base")

    update_plot()
    addTaskCallback(update_plot, name = "vsc.plot")
}

show_view <- !identical(getOption("vsc.view", "Two"), FALSE)
if (show_view) {
    get_column_def <- function(name, field, value) {
        filter <- TRUE
        tooltip <- sprintf(
            "%s, class: [%s], type: %s",
            name,
            toString(class(value)),
            typeof(value)
        )
        if (is.numeric(value)) {
            type <- "numericColumn"
            if (is.null(attr(value, "class"))) {
                filter <- "agNumberColumnFilter"
            }
        } else if (inherits(value, "Date")) {
            type <- "dateColumn"
            filter <- "agDateColumnFilter"
        } else {
            type <- "textColumn"
            filter <- "agTextColumnFilter"
        }
        list(
            headerName = name,
            headerTooltip = tooltip,
            field = field,
            type = type,
            filter = filter
        )
    }

    dataview_table <- function(data) {
        if (is.matrix(data)) {
            data <- as.data.frame.matrix(data)
        }

        if (is.data.frame(data)) {
            .nrow <- nrow(data)
            .colnames <- colnames(data)
            if (is.null(.colnames)) {
                .colnames <- sprintf("V%d", seq_len(ncol(data)))
            } else {
                .colnames <- trimws(.colnames)
            }
            if (.row_names_info(data) > 0L) {
                rownames <- rownames(data)
                rownames(data) <- NULL
            } else {
                rownames <- seq_len(.nrow)
            }
            .colnames <- c("(row)", .colnames)
            fields <- sprintf("x%d", seq_along(.colnames))
            data <- c(list(" " = rownames), .subset(data))
            names(data) <- fields
            class(data) <- "data.frame"
            attr(data, "row.names") <- .set_row_names(.nrow)
            columns <- .mapply(get_column_def,
                list(.colnames, fields, data),
                NULL
            )
            list(
                columns = columns,
                data = data
            )
        } else {
            stop("data must be a data.frame or a matrix")
        }
    }

    show_dataview <- function(x, title, uuid = NULL,
                              viewer = getOption("vsc.view", "Two"),
                              row_limit = abs(getOption("vsc.row_limit", 0))) {
        as_truncated_data <- function(.data) {
            .nrow <- nrow(.data)
            if (row_limit != 0 && row_limit < .nrow) {
                title <<- sprintf("%s (limited to %d/%d)", title, row_limit, .nrow)
                .data <- utils::head(.data, n = row_limit)
            }
            return(.data)
        }

        if (missing(title)) {
            sub <- substitute(x)
            title <- deparse(sub, nlines = 1)
        }
        if (inherits(x, "ArrowTabular")) {
            x <- as_truncated_data(x)
            x <- as.data.frame(x)
        }
        if (is.environment(x)) {
            all_names <- ls(x)
            is_active <- vapply(all_names, bindingIsActive, logical(1), USE.NAMES = TRUE, x)
            is_promise <- rlang::env_binding_are_lazy(x, all_names[!is_active])
            x <- lapply(all_names, function(name) {
                if (isTRUE(is_promise[name])) {
                    data.frame(
                        class = "promise",
                        type = "promise",
                        length = 0L,
                        size = 0L,
                        value = "(promise)",
                        stringsAsFactors = FALSE,
                        check.names = FALSE
                    )
                } else if (isTRUE(is_active[name])) {
                    data.frame(
                        class = "active_binding",
                        type = "active_binding",
                        length = 0L,
                        size = 0L,
                        value = "(active-binding)",
                        stringsAsFactors = FALSE,
                        check.names = FALSE
                    )
                } else {
                    obj <- x[[name]]
                    data.frame(
                        class = paste0(class(obj), collapse = ", "),
                        type = typeof(obj),
                        length = length(obj),
                        size = as.integer(object.size(obj)),
                        value = trimws(try_capture_str(obj, 0)),
                        stringsAsFactors = FALSE,
                        check.names = FALSE
                    )
                }
            })
            names(x) <- all_names
            if (length(x)) {
                x <- do.call(rbind, x)
            } else {
                x <- data.frame(
                    class = character(),
                    type = character(),
                    length = integer(),
                    size = integer(),
                    value = character(),
                    stringsAsFactors = FALSE,
                    check.names = FALSE
                )
            }
        }
        if (is.data.frame(x) || is.matrix(x)) {
            x <- as_truncated_data(x)
            data <- dataview_table(x)
            file <- tempfile(tmpdir = tempdir, fileext = ".json")
            jsonlite::write_json(data, file, na = "string", null = "null", auto_unbox = TRUE, force = TRUE)
            request("dataview", source = "table", type = "json",
                title = title, file = file, viewer = viewer, uuid = uuid
            )
        } else if (is.list(x)) {
            tryCatch({
                file <- tempfile(tmpdir = tempdir, fileext = ".json")
                jsonlite::write_json(x, file, na = "string", null = "null", auto_unbox = TRUE, force = TRUE)
                request("dataview", source = "list", type = "json",
                    title = title, file = file, viewer = viewer, uuid = uuid
                )
            }, error = function(e) {
                file <- file.path(tempdir, paste0(make.names(title), ".txt"))
                text <- utils::capture.output(print(x))
                writeLines(text, file)
                request("dataview", source = "object", type = "txt",
                    title = title, file = file, viewer = viewer, uuid = uuid
                )
            })
        } else {
            file <- file.path(tempdir, paste0(make.names(title), ".R"))
            if (is.primitive(x)) {
                code <- utils::capture.output(print(x))
            } else {
                code <- deparse(x)
            }
            writeLines(code, file)
            request("dataview", source = "object", type = "R",
                title = title, file = file, viewer = viewer, uuid = uuid
            )
        }
    }

    rebind("View", show_dataview, "utils")
}

attach <- function() {
    load_settings()
    if (rstudioapi_enabled()) {
        rstudioapi_util_env$update_addin_registry(addin_registry)
    }
    request("attach",
        version = sprintf("%s.%s", R.version$major, R.version$minor),
        tempdir = tempdir,
        info = list(
            command = commandArgs()[[1L]],
            version = R.version.string,
            start_time = format(file.info(tempdir)$ctime)
        ),
        plot_url = if (identical(names(dev.cur()), "httpgd")) httpgd::hgd_url(),
        server = if (use_webserver) list(
            host = host,
            port = port,
            token = token
        ) else NULL
    )
}

path_to_uri <- function(path) {
    if (length(path) == 0) {
        return(character())
    }
    path <- path.expand(path)
    if (.Platform$OS.type == "windows") {
        prefix <- "file:///"
        path <- gsub("\\", "/", path, fixed = TRUE)
    } else {
        prefix <- "file://"
    }
    paste0(prefix, utils::URLencode(path))
}

request_browser <- function(url, title, ..., viewer) {
    # Printing URL with specific port triggers
    # auto port-forwarding under remote development
    message("Browsing ", url)
    request("browser", url = url, title = title, ..., viewer = viewer)
}

show_browser <- function(url, title = url, ...,
                         viewer = getOption("vsc.browser", "Active")) {
    proxy_uri <- Sys.getenv("VSCODE_PROXY_URI")
    if (nzchar(proxy_uri)) {
        is_base_path <- grepl("\\:\\d+$", url)
        url <- sub("^https?\\://(127\\.0\\.0\\.1|localhost)(\\:)?",
            sub("\\{\\{?port\\}\\}?/?", "", proxy_uri), url
        )
        if (is_base_path) {
            url <- paste0(url, "/")
        }
    }
    if (grepl("^https?\\://(127\\.0\\.0\\.1|localhost)(\\:\\d+)?", url)) {
        request_browser(url = url, title = title, ..., viewer = viewer)
    } else if (grepl("^https?\\://", url)) {
        message(
            if (nzchar(proxy_uri)) {
                "VSCode is not running on localhost but on a remote server.\n"
            } else {
                "VSCode WebView only supports showing local http content.\n"
            },
            "Opening in external browser..."
        )
        request_browser(url = url, title = title, ..., viewer = FALSE)
    } else {
        path <- sub("^file\\://", "", url)
        if (file.exists(path)) {
            path <- normalizePath(path, "/", mustWork = TRUE)
            if (grepl("\\.html?$", path, ignore.case = TRUE)) {
                message(
                    "VSCode WebView has restricted access to local file.\n",
                    "Opening in external browser..."
                )
                request_browser(url = path_to_uri(path),
                    title = title, ..., viewer = FALSE
                )
            } else {
                request("dataview", source = "object", type = "txt",
                    title = title, file = path, viewer = viewer
                )
            }
        } else {
            stop("File not exists")
        }
    }
}

show_webview <- function(url, title, ..., viewer) {
    if (!is.character(url)) {
        real_url <- NULL
        temp_viewer <- function(url, ...) {
            real_url <<- url
        }
        op <- options(viewer = temp_viewer, page_viewer = temp_viewer)
        on.exit(options(op))
        print(url)
        if (is.character(real_url)) {
            url <- real_url
        } else {
            stop("Invalid object")
        }
    }
    proxy_uri <- Sys.getenv("VSCODE_PROXY_URI")
    if (nzchar(proxy_uri)) {
        is_base_path <- grepl("\\:\\d+$", url)
        url <- sub("^https?\\://(127\\.0\\.0\\.1|localhost)(\\:)?",
            sub("\\{\\{?port\\}\\}?/?", "", proxy_uri), url
        )
        if (is_base_path) {
            url <- paste0(url, "/")
        }
    }
    if (grepl("^https?\\://(127\\.0\\.0\\.1|localhost)(\\:\\d+)?", url)) {
        request_browser(url = url, title = title, ..., viewer = viewer)
    } else if (grepl("^https?\\://", url)) {
        message(
            if (nzchar(proxy_uri)) {
                "VSCode is not running on localhost but on a remote server.\n"
            } else {
                "VSCode WebView only supports showing local http content.\n"
            },
            "Opening in external browser..."
        )
        request_browser(url = url, title = title, ..., viewer = FALSE)
    } else if (file.exists(url)) {
        file <- normalizePath(url, "/", mustWork = TRUE)
        request("webview", file = file, title = title, viewer = viewer, ...)
    } else {
        stop("File not exists")
    }
}

show_viewer <- function(url, title = NULL, ...,
                        viewer = getOption("vsc.viewer", "Two")) {
    if (is.null(title)) {
        expr <- substitute(url)
        if (is.character(url)) {
            title <- "Viewer"
        } else {
            title <- deparse(expr, nlines = 1)
        }
    }
    show_webview(url = url, title = title, ..., viewer = viewer)
}

show_page_viewer <- function(url, title = NULL, ...,
                             viewer = getOption("vsc.page_viewer", "Active")) {
    if (is.null(title)) {
        expr <- substitute(url)
        if (is.character(url)) {
            title <- "Page Viewer"
        } else {
            title <- deparse(expr, nlines = 1)
        }
    }
    show_webview(url = url, title = title, ..., viewer = viewer)
}

options(
    browser = show_browser,
    viewer = show_viewer,
    page_viewer = show_page_viewer
)

# rstudioapi
rstudioapi_enabled <- function() {
    isTRUE(getOption("vsc.rstudioapi", TRUE))
}

if (rstudioapi_enabled()) {
    response_timeout <- 5
    response_lock_file <- file.path(dir_session, "response.lock")
    response_file <- file.path(dir_session, "response.log")
    file.create(response_lock_file, showWarnings = FALSE)
    file.create(response_file, showWarnings = FALSE)
    addin_registry <- file.path(dir_session, "addins.json")
    # This is created in attach()

    get_response_timestamp <- function() {
        readLines(response_lock_file)
    }
    # initialise the reponse timestamp to empty string
    response_time_stamp <- ""

    get_response_lock <- function() {
        lock_time_stamp <- get_response_timestamp()
        if (isTRUE(lock_time_stamp != response_time_stamp)) {
            response_time_stamp <<- lock_time_stamp
            TRUE
        } else {
            FALSE
        }
    }

    request_response <- function(command, ...) {
        request(command, ..., sd = dir_session)
        wait_start <- Sys.time()
        while (!get_response_lock()) {
            if ((Sys.time() - wait_start) > response_timeout) {
                stop(
                    "Did not receive a response from VSCode-R API within ",
                    response_timeout, " seconds."
                )
            }
            Sys.sleep(0.1)
        }
        jsonlite::read_json(response_file)
    }

    rstudioapi_util_env <- new.env()
    rstudioapi_env <- new.env(parent = rstudioapi_util_env)
    source(file.path(dir_init, "rstudioapi_util.R"), local = rstudioapi_util_env)
    source(file.path(dir_init, "rstudioapi.R"), local = rstudioapi_env)
    setHook(
        packageEvent("rstudioapi", "onLoad"),
        function(...) {
            rstudioapi_util_env$rstudioapi_patch_hook(rstudioapi_env)
        }
    )
    if ("rstudioapi" %in% loadedNamespaces()) {
        # if the rstudioapi is already loaded, for example via a call to
        # library(tidyverse) in the user's profile, we need to shim it now.
        # There's no harm in having also registered the hook in this case. It can
        # work in the event that the namespace is unloaded and reloaded.
        rstudioapi_util_env$rstudioapi_patch_hook(rstudioapi_env)
    }

}

print.help_files_with_topic <- function(h, ...) {
    viewer <- getOption("vsc.helpPanel", "Two")
    if (!identical(FALSE, viewer) && length(h) >= 1 && is.character(h)) {
        file <- h[1]
        path <- dirname(file)
        dirpath <- dirname(path)
        pkgname <- basename(dirpath)
        requestPath <- paste0(
            "/library/",
            pkgname,
            "/html/",
            basename(file),
            ".html"
        )
        request(command = "help", requestPath = requestPath, viewer = viewer)
    } else {
        utils:::print.help_files_with_topic(h, ...)
    }
    invisible(h)
}

print.hsearch <- function(x, ...) {
    viewer <- getOption("vsc.helpPanel", "Two")
    if (!identical(FALSE, viewer) && length(x) >= 1) {
        requestPath <- paste0(
            "/doc/html/Search?pattern=",
            tools:::escapeAmpersand(x$pattern),
            paste0("&fields.", x$fields, "=1",
                collapse = ""
            ),
            if (!is.null(x$agrep)) paste0("&agrep=", x$agrep),
            if (!x$ignore.case) "&ignore.case=0",
            if (!identical(
                x$types,
                getOption("help.search.types")
            )) {
                paste0("&types.", x$types, "=1",
                    collapse = ""
                )
            },
            if (!is.null(x$package)) {
                paste0(
                    "&package=",
                    paste(x$package, collapse = ";")
                )
            },
            if (!identical(x$lib.loc, .libPaths())) {
                paste0(
                    "&lib.loc=",
                    paste(x$lib.loc, collapse = ";")
                )
            }
        )
        request(command = "help", requestPath = requestPath, viewer = viewer)
    } else {
        utils:::print.hsearch(x, ...)
    }
    invisible(x)
}

# a copy of .S3method(), since this function is new in R 4.0
.S3method <- function(generic, class, method) {
    if (missing(method)) {
        method <- paste(generic, class, sep = ".")
    }
    method <- match.fun(method)
    registerS3method(generic, class, method, envir = parent.frame())
    invisible(NULL)
}

reg.finalizer(.GlobalEnv, function(e) .vsc$request("detach"), onexit = TRUE)
