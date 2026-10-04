# List rows use the same class formatting and numeric precision as table cells.
local({
  runtime <- sess:::.sess_env
  previous <- runtime$dataviews
  previous_options <- options(digits = 3L)
  on.exit({
    runtime$dataviews <- previous
    options(previous_options)
  }, add = TRUE)
  page <- function(object, path = list(), start = 1L) {
    runtime$dataviews$format_test <- sess:::listview_state(object, "x", "x")
    sess:::get_workspace_children(view_id = "format_test", path = path, start = start)
  }
  text <- function(page) vapply(page$children, `[[`, "", "str")

  numbers <- c(1.23456789012345, 1.54e-100, -6.65e-13, 1.23456789012345e14,
               0, NA_real_, NaN, Inf, -Inf)
  expected <- c("1.23456789012345", "1.54e-100", "-6.65e-13", "123456789012345",
                "0", "NA", "NaN", "Inf", "-Inf")
  expect_equal(text(page(numbers)), expected)
  expect_equal(text(page(list(nested = numbers), list(1L))), expected)
  expect_equal(text(page(as.list(numbers))), paste("num", expected))
  for (index in seq_along(numbers)) {
    expect_true(sess:::listview_supported(numbers[index]))
    expect_true(sess:::listview_is_vector(numbers[index]))
    expect_equal(text(page(numbers[index])), expected[index])
    expect_false(page(numbers[index])$children[[1L]]$has_children)
    expect_false(page(numbers[index])$children[[1L]]$viewable)
  }
  expect_true(grepl(expected[[1L]], text(page(list(numbers)))[[1L]], fixed = TRUE))
  expect_equal(text(page(list(matrix(rep(numbers[[1L]], 4L), nrow = 2L)))),
               paste0("num [1:2, 1:2] ", expected[[1L]], " ..."))
  expect_identical(numbers, c(
    1.23456789012345, 1.54e-100, -6.65e-13, 1.23456789012345e14, 0, NA_real_, NaN, Inf, -Inf
  ))
  expect_equal(text(page(c("001", NA_character_))), c('"001"', "NA"))

  registerS3method("[", "listview_number", function(x, ...) {
    structure(NextMethod(), class = class(x), unit = attr(x, "unit"))
  })
  registerS3method("format", "listview_number", function(x, ...) {
    paste0(attr(x, "unit"), ":", sprintf("%.9f", as.numeric(x)))
  })
  registerS3method("[", "listview_label", function(x, ...) {
    structure(NextMethod(), class = class(x))
  })
  registerS3method("format", "listview_label", function(x, ...) {
    paste0("ID:", as.character(x))
  })
  class_env <- environment()
  methods::setClass("listview_s4_number", contains = "numeric", where = class_env)
  methods::setMethod("[", "listview_s4_number", function(x, i, j, ..., drop = TRUE) {
    methods::new("listview_s4_number", as.numeric(x)[i])
  }, where = class_env)
  registerS3method("format", "listview_s4_number", function(x, ...) {
    paste0("S4:", sprintf("%.9f", as.numeric(x)))
  })
  on.exit({
    methods::removeMethod("[", "listview_s4_number", where = class_env)
    methods::removeClass("listview_s4_number", where = class_env)
    rm(list = c("[.listview_number", "format.listview_number", "format.listview_s4_number",
                "[.listview_label", "format.listview_label"),
       envir = get(".__S3MethodsTable__.", asNamespace("base")))
  }, add = TRUE)

  cases <- list(
    S3 = structure(c(1.234567891, NA_real_), class = "listview_number", unit = "USD"),
    S4 = methods::new("listview_s4_number", c(1.234567891, NA_real_)),
    difftime = as.difftime(c(60, NA), units = "secs"),
    factor = factor(c("first", NA)),
    date = as.Date(c("2026-01-01", NA)),
    character_class = structure(c("001", NA_character_), class = "listview_label"),
    complex = c(1 + 2i, NA_complex_)
  )
  if (requireNamespace("bit64", quietly = TRUE)) {
    cases$integer64 <- bit64::as.integer64(c("9007199254740993", NA))
  }
  for (name in names(cases)) {
    values <- cases[[name]]
    original <- serialize(values, NULL)
    table <- data.frame(id = seq_along(values))
    table$value <- values
    table_text <- as.character(sess:::dataview_rows(
      sess:::dataview_to_state(table), seq_along(values)
    )[["2"]])
    table_text[is.na(table_text)] <- "NA"
    expect_equal(text(page(values)), table_text, info = name)
    expect_equal(text(page(list(value = values), list(1L))), table_text, info = name)
    expect_true(grepl(table_text[[1L]], text(page(list(values[1L])))[[1L]], fixed = TRUE),
                info = name)
    expect_identical(serialize(values, NULL), original, info = name)
    scalar <- values[1L]
    expect_true(sess:::listview_supported(scalar), info = name)
    expect_true(sess:::listview_is_vector(scalar), info = name)
    expect_equal(text(page(scalar)), table_text[1L], info = name)
    page(list(value = scalar))
    navigation <- sess:::handle_listview_view("format_test", 1L)
    expect_true(navigation$vector, info = name)
    expect_equal(navigation$path, list(1L), check.attributes = FALSE, info = name)
    expect_false(page(scalar)$children[[1L]]$has_children, info = name)
    expect_false(page(scalar)$children[[1L]]$viewable, info = name)
  }

  values <- structure(rep(1.234567891, 501L), class = "listview_number", unit = "USD")
  names(values) <- paste0("item", seq_along(values))
  first <- page(values)
  last <- page(values, start = 501L)
  expect_length(first$children, 500L)
  expect_equal(first$next_start, 501L)
  expect_equal(unique(text(first)), "USD:1.234567891")
  expect_equal(text(last), "USD:1.234567891")
  expect_equal(last$children[[1L]]$label, "item501")
})
