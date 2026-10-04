# Expanding and opening descendants keeps one list/table viewer per root object.
local({
  runtime <- sess:::.sess_env
  previous_con <- runtime$con
  previous_views <- runtime$dataviews
  previous_registry <- runtime$dataview_registry
  root <- paste0(".sess_listview_test_", Sys.getpid())
  other <- paste0(root, "_other")
  table_root <- paste0(root, "_table")
  pipe <- processx::conn_create_pipepair()
  on.exit({
    sess:::runtime_stop()
    runtime$con <- previous_con
    runtime$dataviews <- previous_views
    runtime$dataview_registry <- previous_registry
    rm(list = c(root, other, table_root), envir = .GlobalEnv)
    lapply(pipe, close)
  }, add = TRUE)
  runtime$con <- pipe[[2L]]
  sess:::runtime_start(use_rstudioapi = FALSE, use_httpgd = FALSE, use_jgd = FALSE)
  x <- list(a = list(b = list(value = 1L), df = data.frame(nested = 2L)),
            df = data.frame(top = 1L))
  assign(root, x, envir = .GlobalEnv)
  assign(other, x, envir = .GlobalEnv)

  # Exercise the JSON-RPC methods used by both the workspace and list webviews.
  notifications <- list()
  read_messages <- function() {
    messages <- strsplit(processx::conn_read_chars(pipe[[1L]]), "\n", fixed = TRUE)[[1L]]
    responses <- lapply(messages[nzchar(messages)], jsonlite::fromJSON, simplifyVector = FALSE)
    notifications <<- Filter(function(message) identical(message$method, "dataview"), responses)
    responses
  }
  notification <- function() {
    if (length(notifications)) tail(notifications, 1L)[[1L]]$params else NULL
  }
  request <- function(method, params) {
    sess:::dispatch_message(as.character(jsonlite::toJSON(
      list(jsonrpc = "2.0", id = "list-test", method = method, params = params),
      auto_unbox = TRUE
    )))
    responses <- read_messages()
    replies <- Filter(function(message) identical(message$id, "list-test"), responses)
    expect_length(replies, 1L)
    expect_null(replies[[1L]]$error)
    replies[[1L]]$result
  }
  id <- function(type, name = root) get(paste0(type, ":", name), runtime$dataview_registry)
  selector <- function(index, name) list(kind = "index", value = index, name = name)

  expect_true(request("workspace_view", list(name = root)))
  list_id <- id("list")
  page <- request("workspace_children", list(view_id = list_id, start = 1L))
  expect_true(page$children[[1L]]$has_children)
  expect_true(page$children[[1L]]$viewable)
  expect_true(page$children[[2L]]$has_children)
  expect_true(page$children[[2L]]$viewable)

  nested <- request("workspace_children", list(view_id = list_id, path = list(1L), start = 1L))
  expect_equal(vapply(nested$children, `[[`, "", "label"), c("$ b", "$ df"))
  expect_identical(runtime$dataviews[[list_id]]$data, x)
  expect_length(runtime$dataviews, 1L)
  leaf <- request("workspace_children", list(view_id = list_id, path = list(1L, 1L), start = 1L))
  expect_false(leaf$children[[1L]]$has_children)
  expect_true(leaf$children[[1L]]$viewable)

  # Open x$df, then x$a$df from an expanded row: the table id is unchanged.
  expect_true(request("listview_view", list(view_id = list_id, index = 2L, path = list())))
  table_id <- id("table")
  expect_false(identical(table_id, list_id))
  expect_true(request("listview_view", list(view_id = list_id, index = 2L, path = list(1L))))
  expect_identical(id("table"), table_id)
  columns <- sess:::handle_dataview_init(list(view_id = table_id))$columns
  expect_equal(as.character(columns[[2L]]$headerName), "nested")

  # The workspace icon and the list icon share the same root's panels.
  expect_true(request("workspace_view", list(name = root, path = list(selector(1L, "a")))))
  expect_identical(id("list"), list_id)
  expect_identical(runtime$dataviews[[list_id]]$data, x)
  navigation <- request("listview_view", list(view_id = list_id, index = 1L, path = list(1L)))
  expect_equal(navigation$title, paste0(root, "$a$b"))
  expect_equal(navigation$path, list(1L, 1L))
  expect_equal(vapply(navigation$breadcrumbs, `[[`, "", "label"), c(root, "a", "b"))
  expect_equal(navigation$breadcrumbs[[2L]]$path, list(1L))
  expect_identical(id("list"), list_id)
  expect_identical(runtime$dataviews[[list_id]]$data, x)
  parent <- request("listview_navigate", list(view_id = list_id, path = list(1L)))
  expect_equal(parent$title, paste0(root, "$a"))
  back <- request("listview_navigate", list(view_id = list_id, path = list()))
  expect_equal(back$title, root)
  expect_equal(back$path, list())
  expect_length(runtime$dataviews, 2L)
  expect_true(request("workspace_view", list(name = root)))
  expect_identical(id("list"), list_id)
  expect_identical(runtime$dataviews[[list_id]]$data, x)

  expect_true(request("workspace_view", list(name = other)))
  expect_false(identical(id("list", other), list_id))
  expect_true(request("workspace_view", list(name = other, path = list(selector(2L, "df")))))
  expect_false(identical(id("table", other), table_id))

  # A list column can use the List Viewer without changing the table root's viewer.
  table_object <- data.frame(id = 1:2)
  table_object$nested <- I(list(list(value = 1L), list(value = 2L)))
  assign(table_root, table_object, envir = .GlobalEnv)
  expect_true(request("workspace_view", list(name = table_root)))
  root_table_id <- id("table", table_root)
  expect_true(request("workspace_view", list(
    name = table_root,
    path = list(selector(1L, "id"))
  )))
  vector_id <- id("list", table_root)
  expect_true(notification()$navigation$vector)
  expect_false(identical(vector_id, root_table_id))
  vector_page <- request("workspace_children", list(
    view_id = vector_id,
    path = list(1L),
    start = 1L
  ))
  expect_equal(vapply(vector_page$children, `[[`, "", "label"), c("[1]", "[2]"))
  expect_equal(vapply(vector_page$children, `[[`, "", "str"), c("1", "2"))
  expect_false(any(vapply(vector_page$children, `[[`, FALSE, "viewable")))
  expect_false(any(vapply(vector_page$children, `[[`, FALSE, "has_children")))
  expect_true(request("workspace_view", list(
    name = table_root,
    path = list(selector(2L, "nested"))
  )))
  table_list_id <- id("list", table_root)
  expect_identical(table_list_id, vector_id)
  expect_false(notification()$navigation$vector)
  expect_false(identical(table_list_id, root_table_id))
  expect_true(request("listview_navigate", list(
    view_id = table_list_id,
    path = list()
  )))
  expect_identical(id("table", table_root), root_table_id)

  # Direct View calls also group nested expressions by their root.
  utils::View(x)
  direct_id <- id("list", "x")
  utils::View(x$a)
  expect_identical(id("list", "x"), direct_id)
  expect_identical(runtime$dataviews[[direct_id]]$data, x)
  utils::View(x$a$b)
  expect_identical(runtime$dataviews[[direct_id]]$data, x)
  direct_context <- sess:::listview_expression_context(quote(x$a$b), environment(), "x", x$a$b)
  expect_equal(direct_context$navigation$path, list(1L, 1L), check.attributes = FALSE)
  expect_equal(direct_context$navigation$title, "x$a$b")
  indexed_context <- sess:::listview_expression_context(
    quote(x[[1L]][[1L]]), environment(), "x", x$a$b
  )
  expect_identical(indexed_context$data, x$a$b)
  expect_equal(indexed_context$navigation$path, list(1L, 1L), check.attributes = FALSE)

  # Active roots are evaluated once, including when inherited by the caller.
  for (inherited in c(FALSE, TRUE)) {
    calls <- 0L
    evaluated <- NULL
    binding_env <- new.env(parent = environment())
    makeActiveBinding("active_root", function() {
      calls <<- calls + 1L
      evaluated <<- list(nested = list(value = c(calls, calls + 10L)))
      evaluated
    }, binding_env)
    caller <- if (inherited) new.env(parent = binding_env) else binding_env
    expressions <- c("active_root", "active_root$nested", "active_root$nested$value")
    for (expression in expressions) {
      calls <- 0L
      eval(parse(text = paste0("utils::View(", expression, ")")), caller)
      read_messages()
      expect_identical(calls, 1L)
      expected <- switch(expression,
        active_root = evaluated,
        "active_root$nested" = evaluated$nested,
        "active_root$nested$value" = evaluated$nested$value
      )
      expect_identical(runtime$dataviews[[id("list", "active_root")]]$data, expected)
      expect_equal(notification()$navigation$title, expression)
      expect_length(notification()$navigation$breadcrumbs, 1L)
    }
  }

  # Custom $ extraction can differ from the indexed path used by breadcrumbs.
  dollar_calls <- 0L
  `$.listview_custom` <- function(object, name) {
    dollar_calls <<- dollar_calls + 1L
    custom_value
  }
  index_calls <- 0L
  `[[.listview_custom` <- function(object, index) {
    index_calls <<- index_calls + 1L
    unclass(object)[[index]]
  }
  # Register the method so dispatch inside the package can find it too.
  registerS3method("[[", "listview_custom", `[[.listview_custom`, envir = asNamespace("base"))
  on.exit({
    rm("[[.listview_custom", envir = get(".__S3MethodsTable__.", asNamespace("base")))
  }, add = TRUE)
  custom <- structure(list(a = c(1L, 2L)), class = "listview_custom")
  outer <- list(custom = custom)
  for (custom_value in list(c(90L, 91L), list(returned = c(90L, 91L)))) {
    for (expression in c("custom$a", "outer$custom$a")) {
      dollar_calls <- 0L
      index_calls <- 0L
      eval(parse(text = paste0("utils::View(", expression, ")")))
      read_messages()
      expect_identical(dollar_calls, 1L)
      expect_null(sess:::listview_expression_context(
        parse(text = expression)[[1L]], environment(), "custom", custom_value
      ))
      expect_identical(index_calls, 0L)
      view_id <- notification()$view_id
      expect_identical(runtime$dataviews[[view_id]]$data, custom_value)
      expect_equal(notification()$navigation$title, expression)
      expect_length(notification()$navigation$breadcrumbs, 1L)
      expect_length(notification()$navigation$path, 0L)
      page <- sess:::get_workspace_children(view_id = view_id)
      if (is.atomic(custom_value)) {
        expect_equal(vapply(page$children, `[[`, "", "str"), c("90", "91"))
      } else {
        expect_equal(page$children[[1L]]$label, "$ returned")
      }
    }
  }

  index_calls <- 0L
  utils::View(custom[["a"]])
  read_messages()
  expect_identical(index_calls, 1L)
  expect_identical(runtime$dataviews[[notification()$view_id]]$data, c(1L, 2L))

  # A locally rebound operator changes extraction even for an ordinary list.
  for (operator in c("$", "[[", "@")) {
    for (active in c(FALSE, TRUE)) {
      caller <- new.env(parent = environment())
      caller$x <- list(a = c(1L, 2L))
      extraction_calls <- 0L
      binding_calls <- 0L
      extraction <- function(object, name) {
        extraction_calls <<- extraction_calls + 1L
        c(90L, 91L)
      }
      if (active) {
        makeActiveBinding(operator, function() {
          binding_calls <<- binding_calls + 1L
          extraction
        }, caller)
      } else {
        assign(operator, extraction, envir = caller)
      }
      expression <- switch(operator, "$" = "x$a", "[[" = "x[[1L]]", "@" = "x@a")
      eval(parse(text = paste0("utils::View(", expression, ")")), caller)
      read_messages()
      expect_identical(extraction_calls, 1L)
      expect_identical(binding_calls, if (active) 1L else 0L)
      expect_identical(runtime$dataviews[[notification()$view_id]]$data, c(90L, 91L))
      expect_length(notification()$navigation$path, 0L)
    }
  }

  # Standard data-frame columns retain their parent navigation.
  frame <- data.frame(values = 1:2)
  for (expression in c("frame$values", "frame$val", "frame[[1L]]", "frame[['values']]")) {
    eval(parse(text = paste0("utils::View(", expression, ")")))
    read_messages()
    expect_identical(runtime$dataviews[[notification()$view_id]]$data, frame)
    expect_equal(notification()$navigation$path, list(1L))
    expect_equal(vapply(notification()$navigation$breadcrumbs, `[[`, "", "label"),
                 c("frame", "values"))
  }

  # Local S3 overrides of standard data-frame extraction must also run only once.
  for (operator in c("$", "[[")) {
    caller <- new.env(parent = environment())
    caller$frame <- frame
    extraction_calls <- 0L
    assign(paste0(operator, ".data.frame"), function(object, name) {
      extraction_calls <<- extraction_calls + 1L
      c(90L, 91L)
    }, envir = caller)
    expression <- if (operator == "$") "frame$values" else "frame[[1L]]"
    eval(parse(text = paste0("utils::View(", expression, ")")), caller)
    read_messages()
    expect_identical(extraction_calls, 1L)
    expect_identical(runtime$dataviews[[notification()$view_id]]$data, c(90L, 91L))
    expect_length(notification()$navigation$path, 0L)
  }

  # A structural path must not replace an already-evaluated, different value.
  expect_null(sess:::listview_expression_context(
    quote(x$a$b), environment(), "x", list(other = 1L)
  ))

  utils::View(x$df)
  direct_table <- id("table", "x")
  utils::View(x$a$df)
  expect_identical(id("table", "x"), direct_table)
  utils::View(seq_len(501L))
  direct_vector <- id("list", "seq_len(501L)")
  first_vector_page <- sess:::get_workspace_children(
    view_id = direct_vector,
    start = 1L
  )
  expect_length(first_vector_page$children, 500L)
  expect_equal(first_vector_page$next_start, 501L)
  last_vector_page <- sess:::get_workspace_children(
    view_id = direct_vector,
    start = 501L
  )
  expect_length(last_vector_page$children, 1L)
  expect_equal(last_vector_page$children[[1L]]$label, "[501]")
  expect_equal(last_vector_page$children[[1L]]$str, "501")

  # Named vectors retain names, duplicates and positions across page boundaries.
  named_values <- seq_len(501L)
  names(named_values) <- rep("", length(named_values))
  names(named_values)[c(1L, 3L, 4L, 5L, 6L, 7L, 501L)] <-
    c("first", "first", NA, "a b", "<tag>", "\u540d\u524d", "last")
  named_root <- list(values = named_values)
  for (expression in c("named_values", "named_root$values")) {
    eval(parse(text = paste0("utils::View(", expression, ")")))
    read_messages()
    params <- list(view_id = notification()$view_id, path = notification()$navigation$path)
    page <- do.call(sess:::get_workspace_children, params)
    expect_equal(vapply(page$children[seq_len(7L)], `[[`, "", "label"),
                 c("first", "[2]", "first", "[4]", "a b", "<tag>", "\u540d\u524d"))
    expect_equal(vapply(page$children[seq_len(7L)], `[[`, "", "str"), as.character(seq_len(7L)))
    expect_equal(vapply(page$children, `[[`, 0L, "index"), seq_len(500L))
    expect_false(any(vapply(page$children, `[[`, FALSE, "has_children")))
    expect_false(any(vapply(page$children, `[[`, FALSE, "viewable")))
    expect_equal(page$next_start, 501L)
    params$start <- page$next_start
    last <- request("workspace_children", params)
    expect_equal(last$children[[1L]]$label, "last")
    expect_equal(last$children[[1L]]$str, "501")
    expect_equal(last$children[[1L]]$index, 501L)
    expect_null(last$next_start)
  }

  utils::View(x$a$b$value)
  text_id <- id("object", "x")
  text_file <- runtime$dataviews[[text_id]]$file
  utils::View(x$a$df$nested)
  expect_identical(id("object", "x"), text_id)
  expect_identical(runtime$dataviews[[text_id]]$file, text_file)
  expect_equal(readLines(text_file), "2L")
  unlink(text_file)

  # Vectors opened from expanded list rows retain the root and every breadcrumb.
  values <- list(nested = list(v = seq_len(501L)))
  assign(other, values, envir = .GlobalEnv)
  expect_true(request("workspace_view", list(name = other)))
  values_list_id <- id("list", other)
  vector_navigation <- request("listview_view", list(
    view_id = values_list_id, path = list(1L), index = 1L
  ))
  expect_length(notifications, 0L)
  expect_true(vector_navigation$vector)
  expect_equal(vector_navigation$path, list(1L, 1L))
  expect_equal(vapply(vector_navigation$breadcrumbs, `[[`, "", "label"),
               c(other, "nested", "v"))
  expect_identical(runtime$dataviews[[values_list_id]]$data, values)
  first <- sess:::get_workspace_children(view_id = values_list_id, path = list(1L, 1L))
  expect_length(first$children, 500L)
  expect_equal(first$next_start, 501L)
  last <- request("workspace_children", list(
    view_id = values_list_id, path = list(1L, 1L), start = 501L
  ))
  expect_equal(vapply(last$children, `[[`, "", "str"), "501")
  parent <- request("listview_navigate", list(view_id = values_list_id, path = list(1L)))
  expect_length(notifications, 0L)
  expect_false(parent$vector)
  expect_equal(parent$path, list(1L))
  back <- request("listview_navigate", list(view_id = values_list_id, path = list(1L, 1L)))
  expect_equal(back, vector_navigation)
  expect_true(request("workspace_view", list(
    name = other, path = list(selector(1L, "nested"), selector(1L, "v"))
  )))
  expect_equal(notification()$view_id, values_list_id)
  expect_equal(notification()$source, "list")
  expect_equal(notification()$navigation, vector_navigation)
  utils::View(values)
  direct_values_id <- id("list", "values")
  utils::View(values$nested$v)
  read_messages()
  expect_equal(notification()$view_id, direct_values_id)
  expect_true(notification()$navigation$vector)
  expect_equal(notification()$navigation$path, list(1L, 1L))
  expect_equal(vapply(notification()$navigation$breadcrumbs, `[[`, "", "label"),
               c("values", "nested", "v"))

  # POSIXlt values are vector leaves, including scalar, missing and empty values.
  dates <- as.POSIXlt(c("2026-01-01 12:34:56", "2026-01-02 01:02:03", NA), tz = "UTC")
  for (sample in list(dates, dates[1L], dates[3L], dates[FALSE])) {
    utils::View(sample, title = "POSIXlt values")
    read_messages()
    expect_equal(notification()$source, "list")
    expect_true(notification()$navigation$vector)
    page <- request("workspace_children", list(view_id = notification()$view_id))
    expect_length(page$children, length(sample))
    expected <- format(sample, "%Y-%m-%d %H:%M:%S")
    expected[is.na(expected)] <- "NA"
    expect_equal(vapply(page$children, `[[`, "", "str"), expected)
    expect_false(any(vapply(page$children, `[[`, FALSE, "has_children")))
    expect_false(any(vapply(page$children, `[[`, FALSE, "viewable")))
    expect_equal(sess:::workspace_child_count(sample), 0L)
  }
  values <- list(dates = dates)
  assign(other, values, envir = .GlobalEnv)
  expect_true(request("workspace_view", list(name = other)))
  page <- request("workspace_children", list(name = other))
  expect_false(page$children[[1L]]$has_children)
  expect_true(page$children[[1L]]$viewable)
  page <- request("workspace_children", list(view_id = values_list_id))
  expect_false(page$children[[1L]]$has_children)
  expect_true(page$children[[1L]]$viewable)
  navigation <- request("listview_view", list(view_id = values_list_id, index = 1L))
  expect_length(notifications, 0L)
  expect_true(navigation$vector)
  expect_equal(navigation$path, list(1L))
  expect_true(request("workspace_view", list(name = other, path = list(selector(1L, "dates")))))
  expect_equal(notification()$source, "list")
  expect_equal(notification()$view_id, values_list_id)
  expect_equal(notification()$navigation, navigation)
  expect_false(any(startsWith(ls(runtime$dataview_registry), "vector:")))

  # Invalid or unavailable descendants cannot navigate or force active bindings.
  expect_false(sess:::handle_listview_view(list_id, 0L))
  expect_false(sess:::handle_listview_view(list_id, 1.5))
  expect_false(sess:::handle_listview_view(list_id, 1L, list(99L)))
  expect_true(sess:::handle_dataview_dispose(list(view_id = list_id)))
  expect_null(runtime$dataviews[[list_id]])
  sess:::handle_workspace_view(root)
  expect_identical(id("list"), list_id)
  expect_identical(runtime$dataviews[[list_id]]$data, x)
})

# Nested expansion pages retain lazy loading and handle environments, pairlists and slots.
local({
  runtime <- sess:::.sess_env
  previous <- runtime$dataviews
  on.exit(runtime$dataviews <- previous, add = TRUE)
  env <- new.env(parent = emptyenv())
  env$child <- pairlist(value = list(1L))
  makeActiveBinding("active", function() stop("active binding evaluated"), env)
  methods::setClass("list_viewer_nested_slots", slots = c(child = "list"))
  on.exit(methods::removeClass("list_viewer_nested_slots"), add = TRUE)
  object <- list(
    many = rep(list(list(value = 1L)), 501L),
    env = env,
    slots = methods::new("list_viewer_nested_slots", child = list(value = 1L))
  )
  runtime$dataviews$nested_test <- list(
    type = "list", data = object, kind = "index", names = names(object), title = "object",
    child_names = new.env(parent = emptyenv())
  )
  page <- function(path, start = 1L) {
    sess:::get_workspace_children(view_id = "nested_test", path = path, start = start)
  }
  first <- page(list(1L))
  expect_length(first$children, 500L)
  expect_equal(first$next_start, 501L)
  last <- page(list(1L), 501L)
  expect_length(last$children, 1L)
  expect_equal(last$children[[1L]]$index, 501L)
  expect_true(last$children[[1L]]$has_children)
  expect_equal(page(list(1L, 501L))$children[[1L]]$label, "$ value")
  env_page <- page(list(2L))
  labels <- vapply(env_page$children, `[[`, "", "label")
  active_index <- match("$ active", labels)
  child_index <- match("$ child", labels)
  expect_false(env_page$children[[active_index]]$viewable)
  expect_false(sess:::handle_listview_view("nested_test", active_index, list(2L)))
  expect_true(page(list(2L, child_index))$children[[1L]]$has_children)
  rm("child", envir = env)
  env$replacement <- list(value = 2L)
  changed <- page(list(2L))
  expect_equal(changed$children[[child_index]]$label, "$ child")
  expect_false(changed$children[[child_index]]$viewable)
  expect_false(sess:::handle_listview_view("nested_test", child_index, list(2L)))
  expect_equal(page(list(3L))$children[[1L]]$label, "@ child")
  expect_equal(page(list(3L, 1L))$children[[1L]]$label, "$ value")
})

# Resolve a deep selector path once rather than repeatedly extracting its prefixes.
local({
  class_name <- paste0("sess_counted_list_", Sys.getpid())
  method_name <- paste0("[[.", class_name)
  extractions <- 0L
  assign(method_name, function(object, index, ...) {
    extractions <<- extractions + 1L
    unclass(object)[[index]]
  }, envir = .GlobalEnv)
  on.exit(rm(list = method_name, envir = .GlobalEnv), add = TRUE)
  object <- 1:3
  for (i in seq_len(6L)) object <- structure(list(child = object), class = class_name)
  root <- sess:::listview_state(object, "object", "object")
  selectors <- rep(list(list(kind = "index", value = 1L)), 6L)
  context <- sess:::listview_context(root, selectors)
  expect_equal(extractions, 6L)
  expect_identical(context$data, 1:3)
  expect_equal(context$navigation$path, rep(list(1L), 6L), check.attributes = FALSE)
  expect_equal(context$navigation$title, paste0("object", paste(rep("$child", 6L), collapse = "")))
})

# Repeated pages use cached environment names without enumerating bindings again.
local({
  scans <- 0L
  location <- sess:::listview_location
  environment(location) <- new.env(parent = environment(location))
  environment(location)$workspace_env_names <- function(object) {
    scans <<- scans + 1L
    sess:::workspace_env_names(object)
  }
  child <- new.env(parent = emptyenv())
  child$value <- 1:3
  root <- sess:::listview_state(list(child = child), "object", "object")
  first <- location(root, list(1L))
  expect_equal(scans, 1L)
  child$added <- 4:6
  again <- location(root, list(1L))
  expect_equal(scans, 1L)
  expect_identical(again$names, first$names)
})
