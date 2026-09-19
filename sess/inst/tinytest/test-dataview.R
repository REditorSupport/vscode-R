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

# Arbitrary classes supply their own display and text-filter values.
local({
  registerS3method("[", "dataview_test", function(x, ...) {
    structure(NextMethod(), class = class(x))
  })
  registerS3method("format", "dataview_test", function(x, ...) {
    paste0("value:", unclass(x))
  })
  on.exit(rm(
    list = c("[.dataview_test", "format.dataview_test"),
    envir = get(".__S3MethodsTable__.", envir = asNamespace("base"))
  ), add = TRUE)

  df <- data.frame(id = 1:4)
  df$value <- structure(c(20, 2, 10, NA_real_), class = "dataview_test")
  state <- sess:::dataview_to_state(df)
  expect_equal(as.character(state$columns[[3L]]$type), "textColumn")
  expect_equal(as.character(state$columns[[3L]]$filter), "agTextColumnFilter")
  expect_equal(
    sess:::dataview_rows(state, 1:4)[["2"]],
    c("value:20", "value:2", "value:10", NA_character_)
  )
  expect_equal(sess:::dataview_query_indices(
    state, NULL, list("2" = list(type = "equals", filter = "value:2"))
  ), 2L)
})
