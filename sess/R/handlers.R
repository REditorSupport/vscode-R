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

handle_complete <- function(expr_str, trigger) {
  obj <- tryCatch({
    expr <- parse(text = expr_str, keep.source = FALSE)[[1]]
    eval(expr, .GlobalEnv)
  }, error = function(e) NULL)

  if (is.null(obj)) {
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