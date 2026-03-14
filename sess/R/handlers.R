# Handlers for the client Pull Requests (HTTP GET/POST)

get_workspace_data <- function() {
  env <- .GlobalEnv
  all_names <- ls(env)
  
  objs <- lapply(all_names, function(name) {
    obj <- env[[name]]
    list(
      class = class(obj),
      type = typeof(obj),
      length = length(obj),
      # Create a concise string representation
      str = paste0(utils::capture.output(utils::str(obj, max.level = 0, give.attr = FALSE)), collapse = "\n")
    )
  })
  names(objs) <- all_names
  
  list(
    globalenv = objs,
    search = search()[-1],
    loaded_namespaces = loadedNamespaces()
  )
}

handle_hover <- function(expr_str) {
  tryCatch({
    expr <- parse(text = expr_str, keep.source = FALSE)[[1]]
    obj <- eval(expr, .GlobalEnv)
    str_preview <- paste0(utils::capture.output(utils::str(obj, max.level = 0, give.attr = FALSE)), collapse = "\n")
    list(str = str_preview)
  }, error = function(e) NULL)
}

handle_complete <- function(expr_str, trigger = NULL) {
  obj <- tryCatch({
    expr <- parse(text = expr_str, keep.source = FALSE)[[1]]
    eval(expr, .GlobalEnv)
  }, error = function(e) NULL)

  if (is.null(obj) || is.null(trigger)) {
    return(NULL)
  }

  if (trigger == "$") {
    nms <- if (is.object(obj)) {
      utils::.DollarNames(obj, pattern = "")
    } else if (is.recursive(obj)) {
      names(obj)
    } else {
      NULL
    }
    
    if (is.null(nms)) return(NULL)
    
    return(lapply(nms, function(n) {
      item <- obj[[n]]
      list(
        name = n, 
        type = typeof(item), 
        str = paste0(class(item), collapse = ", ")
      )
    }))
  }

  if (trigger == "@" && methods::isS4(obj)) {
    nms <- methods::slotNames(obj)
    return(lapply(nms, function(n) {
      item <- methods::slot(obj, n)
      list(
        name = n, 
        type = typeof(item), 
        str = paste0(class(item), collapse = ", ")
      )
    }))
  }
  
  NULL
}

handle_plot_latest <- function(params) {
  record <- .sess_env$latest_plot_record
  if (is.null(record)) {
    return(list(data = NULL))
  }

  width <- if (is.null(params$width)) 800 else as.numeric(params$width)
  height <- if (is.null(params$height)) 600 else as.numeric(params$height)
  format <- if (is.null(params$format)) "svglite" else as.character(params$format)

  plot_file <- tempfile(tmpdir = .sess_env$tempdir, fileext = paste0(".", format))

  if (format == "svglite") {
    if (requireNamespace("svglite", quietly = TRUE)) {
      svglite::svglite(plot_file, width = width / 72, height = height / 72)
    } else {
      # Fallback to png
      png(plot_file, width = width, height = height, res = 72)
    }
  } else {
    png(plot_file, width = width, height = height, res = 72)
  }

  on.exit({
    if (dev.cur() > 1) dev.off()
    if (file.exists(plot_file)) unlink(plot_file)
  })

  replayPlot(record)
  dev.off()

  if (file.exists(plot_file)) {
    raw_img <- readBin(plot_file, "raw", file.info(plot_file)$size)
    list(
      data = as.character(jsonlite::base64_enc(raw_img)),
      format = if (format == "svglite" && !requireNamespace("svglite", quietly = TRUE)) "png" else format
    )
  } else {
    list(data = NULL)
  }
}
