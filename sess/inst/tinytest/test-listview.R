# Expanding and opening descendants keeps one list/table viewer per root object.
local({
  runtime <- sess:::.sess_env
  previous_con <- runtime$con
  previous_views <- runtime$dataviews
  previous_registry <- runtime$dataview_registry
  root <- paste0(".sess_listview_test_", Sys.getpid())
  other <- paste0(root, "_other")
  pipe <- processx::conn_create_pipepair()
  on.exit({
    sess:::runtime_stop()
    runtime$con <- previous_con
    runtime$dataviews <- previous_views
    runtime$dataview_registry <- previous_registry
    rm(list = c(root, other), envir = .GlobalEnv)
    lapply(pipe, close)
  }, add = TRUE)
  runtime$con <- pipe[[2L]]
  sess:::runtime_start(use_rstudioapi = FALSE, use_httpgd = FALSE, use_jgd = FALSE)
  x <- list(a = list(b = list(value = 1L), df = data.frame(nested = 2L)),
            df = data.frame(top = 1L))
  assign(root, x, envir = .GlobalEnv)
  assign(other, x, envir = .GlobalEnv)

  # Exercise the JSON-RPC methods used by both the workspace and list webviews.
  request <- function(method, params) {
    sess:::dispatch_message(as.character(jsonlite::toJSON(
      list(jsonrpc = "2.0", id = "list-test", method = method, params = params),
      auto_unbox = TRUE
    )))
    messages <- strsplit(processx::conn_read_chars(pipe[[1L]]), "\n", fixed = TRUE)[[1L]]
    responses <- lapply(messages[nzchar(messages)], jsonlite::fromJSON, simplifyVector = FALSE)
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

  # Direct View calls also group nested expressions by their root.
  utils::View(x)
  direct_id <- id("list", "x")
  utils::View(x$a)
  expect_identical(id("list", "x"), direct_id)
  expect_identical(runtime$dataviews[[direct_id]]$data, x)
  utils::View(x$a$b)
  expect_identical(runtime$dataviews[[direct_id]]$data, x)
  direct_context <- sess:::listview_expression_context(quote(x$a$b), environment(), "x")
  expect_equal(direct_context$navigation$path, list(1L, 1L), check.attributes = FALSE)
  expect_equal(direct_context$navigation$title, "x$a$b")
  utils::View(x$df)
  direct_table <- id("table", "x")
  utils::View(x$a$df)
  expect_identical(id("table", "x"), direct_table)
  utils::View(x$a$b$value)
  text_id <- id("object", "x")
  text_file <- runtime$dataviews[[text_id]]$file
  utils::View(x$a$df$nested)
  expect_identical(id("object", "x"), text_id)
  expect_identical(runtime$dataviews[[text_id]]$file, text_file)
  expect_equal(readLines(text_file), "2L")
  unlink(text_file)

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
