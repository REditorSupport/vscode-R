# Small numbers survive the actual JSON response and remain distinct in cached filters.
local({
  .sess_env <- sess:::.sess_env
  orig_dataviews <- .sess_env$dataviews
  orig_con <- .sess_env$con
  pipe <- processx::conn_create_pipepair()
  on.exit({
    .sess_env$dataviews <- orig_dataviews
    .sess_env$con <- orig_con
    lapply(pipe, close)
  }, add = TRUE)
  .sess_env$con <- pipe[[2L]]

  values <- c(1.54e-05, 3.54e-05, -6.65e-13, 1.54e-100, 0, 1.23456789)
  registration <- sess:::dataview_register(data.frame(value = values))
  page <- sess:::handle_dataview_page(list(view_id = registration$view_id))
  sess:::rpc_reply("page", page)
  response <- jsonlite::fromJSON(processx::conn_read_chars(pipe[[1L]]))
  actual <- response$result$rows[["1"]]
  expect_length(actual, length(values))
  expect_true(all(abs(actual - values) <= abs(values) * 1e-14))

  for (value in values[1:2]) {
    filtered <- sess:::handle_dataview_page(list(
      view_id = registration$view_id,
      filterModel = list("1" = list(type = "equals", filter = value))
    ))
    expect_equal(filtered$rows[["1"]], value, tolerance = 1e-14)
  }
})

# S3 and S4 numeric subclasses supply their own display and text-filter values.
local({
  registerS3method("[", "dataview_test", function(x, ...) {
    structure(NextMethod(), class = class(x))
  })
  class_env <- environment()
  methods::setClass("dataview_s4_test", contains = "numeric", where = class_env)
  on.exit({
    methods::removeMethod("[", "dataview_s4_test", where = class_env)
    methods::removeClass("dataview_s4_test", where = class_env)
    rm(
      list = c("[.dataview_test", "format.dataview_test", "format.dataview_s4_test"),
      envir = get(".__S3MethodsTable__.", envir = asNamespace("base"))
    )
  }, add = TRUE)
  methods::setMethod("[", "dataview_s4_test", function(x, i, j, ..., drop = TRUE) {
    methods::new("dataview_s4_test", as.numeric(x)[i])
  }, where = class_env)
  for (class_name in c("dataview_test", "dataview_s4_test")) {
    registerS3method("format", class_name, function(x, ...) {
      paste0("value:", as.numeric(x))
    })
  }

  values <- c(20, 2, 10, NA_real_)
  cases <- list(
    S3 = structure(values, class = "dataview_test"),
    S4 = methods::new("dataview_s4_test", values)
  )
  for (case_name in names(cases)) {
    df <- data.frame(id = 1:4)
    df$value <- cases[[case_name]]
    expect_equal(isS4(df$value), case_name == "S4", info = case_name)
    expect_true(is.numeric(df$value), info = case_name)
    expect_true(is.object(df$value), info = case_name)

    state <- sess:::dataview_to_state(df)
    expect_equal(as.character(state$columns[[3L]]$type), "textColumn", info = case_name)
    expect_equal(
      as.character(state$columns[[3L]]$filter), "agTextColumnFilter", info = case_name
    )
    expect_equal(
      sess:::dataview_rows(state, 1:4)[["2"]],
      c("value:20", "value:2", "value:10", NA_character_), info = case_name
    )
    expect_equal(sess:::dataview_query_indices(
      state, NULL, list("2" = list(type = "equals", filter = "value:2"))
    ), 2L, info = case_name)
  }
})


# Workspace children expose View for both structured and text-viewable objects.
local({
  selector <- list(kind = "index", value = 1L)
  expect_true(sess:::workspace_child_item(data.frame(x = 1), "df", selector)$viewable)
  expect_true(sess:::workspace_child_item(matrix(1:4, 2), "matrix", selector)$viewable)
  expect_true(sess:::workspace_child_item(list(x = 1), "list", selector)$viewable)
  expect_true(sess:::workspace_child_item(new.env(), "environment", selector)$viewable)
  expect_true(sess:::workspace_child_item(pairlist(x = 1), "pairlist", selector)$viewable)
  methods::setClass("list_viewer_test_slots", slots = c(child = "list"))
  on.exit(methods::removeClass("list_viewer_test_slots"), add = TRUE)
  object <- methods::new("list_viewer_test_slots", child = list(x = 1))
  expect_true(sess:::workspace_child_item(object, "S4", selector)$viewable)
  expect_true(sess:::workspace_child_item(1:3, "vector", selector)$viewable)
})

# List pages inspect only the requested children, with stable indices across pages.
local({
  runtime <- sess:::.sess_env
  previous <- runtime$dataviews
  on.exit(runtime$dataviews <- previous, add = TRUE)
  object <- new.env(parent = emptyenv())
  child_names <- paste0("item", seq_len(501L))
  for (name in child_names[1:500]) assign(name, 1L, envir = object)
  delayedAssign("item501", stop("unrequested binding was evaluated"), assign.env = object)
  runtime$dataviews$paging_test <- list(
    type = "list", data = object, kind = "name", names = child_names, title = "object"
  )

  first <- sess:::get_workspace_children(view_id = "paging_test", start = 1L)
  expect_length(first$children, 500L)
  expect_equal(first$next_start, 501L)
  expect_equal(vapply(first$children, `[[`, 1L, "index"), 1:500)

  # Removing a binding must not shift later indices or fail the next page.
  rm("item501", envir = object)
  last <- sess:::get_workspace_children(view_id = "paging_test", start = 501L)
  expect_equal(last$children[[1L]]$label, "$ item501")
  expect_false(last$children[[1L]]$viewable)
  expect_null(last$next_start)
  makeActiveBinding("item501", function() stop("active binding was evaluated"), object)
  last <- sess:::get_workspace_children(view_id = "paging_test", start = 501L)
  expect_equal(last$children[[1L]]$str, "(active-binding)")
  expect_false(last$children[[1L]]$viewable)
  expect_length(sess:::get_workspace_children(view_id = "paging_test", start = 502L)$children, 0L)
})
