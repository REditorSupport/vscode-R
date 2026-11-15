# Hover and completion requests are parsed and resolved without evaluating them.
local({
  hover <- sess:::inspection_hover
  completion <- sess:::inspection_completion
  capture_str <- sess:::capture_str
  prefix <- "sess_inspection_"
  # The test masks these names in the global environment; restore any that
  # existed before so that running it in a live session is harmless.
  masked <- c("$", "@", "T", "$.sess_inspection_s3", ".DollarNames.sess_inspection_s3")
  saved <- mget(intersect(masked, ls(.GlobalEnv, all.names = TRUE)), envir = .GlobalEnv)
  on.exit({
    rm(list = ls(.GlobalEnv, all.names = TRUE, pattern = paste0("^", prefix)), envir = .GlobalEnv)
    rm(list = intersect(masked, ls(.GlobalEnv, all.names = TRUE)), envir = .GlobalEnv)
    list2env(saved, envir = .GlobalEnv)
    if ("sess_inspection_search" %in% search()) {
      detach("sess_inspection_search", character.only = TRUE)
    }
  })
  global <- function(name, value) assign(paste0(prefix, name), value, envir = .GlobalEnv)
  invalid <- function(expr, trigger = NULL) {
    condition <- tryCatch(
      if (is.null(trigger)) hover(expr) else completion(expr, trigger),
      error = function(e) e
    )
    inherits(condition, "sess_inspection_invalid")
  }

  # Names: the global environment first, then the search path.
  global("value", list(a = 1L))
  expect_identical(hover("sess_inspection_value"), list(str = capture_str(list(a = 1L))))
  expect_identical(hover("pi"), list(str = capture_str(pi)))
  search_env <- attach(NULL, name = "sess_inspection_search")
  assign("sess_inspection_shadowed", "search", envir = search_env)
  expect_identical(hover("sess_inspection_shadowed")$str, capture_str("search"))
  global("shadowed", "global")
  expect_identical(hover("sess_inspection_shadowed")$str, capture_str("global"))
  expect_null(hover("sess_inspection_missing"))
  expect_null(completion("sess_inspection_missing", "$"))
  global("null", NULL)
  expect_identical(hover("sess_inspection_null"), list(str = capture_str(NULL)))

  # Promises and active bindings on the path are read once.
  counter <- new.env()
  counter$forced <- 0L
  delayedAssign(
    "sess_inspection_promise",
    {
      counter$forced <- counter$forced + 1L
      list(a = list(b = 2L))
    },
    assign.env = .GlobalEnv
  )
  expect_identical(hover("sess_inspection_promise$a$b")$str, capture_str(2L))
  expect_identical(counter$forced, 1L)
  active <- 0L
  makeActiveBinding(
    "sess_inspection_active",
    function() {
      active <<- active + 1L
      list(x = 1L, y = "a")
    },
    .GlobalEnv
  )
  expect_identical(hover("sess_inspection_active$x")$str, capture_str(1L))
  expect_identical(active, 1L)
  expect_identical(vapply(completion("sess_inspection_active", "$"), `[[`, "", "name"), c("x", "y"))
  expect_identical(active, 2L)

  # Accessors on base structures, mixed chains and quoted members.
  global("nested", list(a = list(b = "leaf")))
  expect_identical(hover("sess_inspection_nested$a$b")$str, capture_str("leaf"))
  expect_identical(hover("sess_inspection_nested $ a $ b")$str, capture_str("leaf"))
  expect_identical(hover("sess_inspection_nested$\"a\"")$str, capture_str(list(b = "leaf")))
  expect_identical(hover("sess_inspection_nested$none")$str, capture_str(NULL))
  global("frame", data.frame(x = 1:3))
  expect_identical(hover("sess_inspection_frame$x")$str, capture_str(1:3))
  env <- new.env()
  env$v <- "in env"
  global("env", env)
  expect_identical(hover("sess_inspection_env$v")$str, capture_str("in env"))
  global("vector", 1:3)
  expect_null(hover("sess_inspection_vector$a"))

  # S3 `$` methods defined in the global environment dispatch as at the console.
  global("s3", structure(list(), class = "sess_inspection_s3"))
  assign("$.sess_inspection_s3", function(x, name) paste("member", name), envir = .GlobalEnv)
  expect_identical(hover("sess_inspection_s3$abc")$str, capture_str("member abc"))

  # S4 slots, also mixed with `$`.
  methods::setClass("sess_inspection_s4", representation(items = "list"), where = .GlobalEnv)
  global("s4", methods::new("sess_inspection_s4", items = list(a = "slot item")))
  expect_identical(hover("sess_inspection_s4@items$a")$str, capture_str("slot item"))
  expect_null(hover("sess_inspection_s4@missing"))
  # Pseudo-slots that base `@` reads but methods::.hasSlot() does not report.
  expect_identical(hover("sess_inspection_s4@.S3Class")$str, capture_str("sess_inspection_s4"))
  methods::setClass("sess_inspection_s4_list", contains = "list", where = .GlobalEnv)
  global("s4_list", methods::new("sess_inspection_s4_list", list(1L)))
  expect_identical(hover("sess_inspection_s4_list@.Data")$str, capture_str(list(1L)))
  expect_identical(hover("sess_inspection_s4_list@names")$str, capture_str(NULL))
  # Errors other than a missing slot are not hidden.
  methods::removeClass("sess_inspection_s4_list", where = .GlobalEnv)
  expect_error(hover("sess_inspection_s4_list@.Data"))
  expect_null(hover("sess_inspection_nested@a"))
  expect_identical(vapply(completion("sess_inspection_s4", "@"), `[[`, "", "name"), "items")
  # Masking `$` or `@` in the global environment does not change the operators.
  assign("$", function(x, name) stop("masked $ was called"), envir = .GlobalEnv)
  assign("@", function(object, name) stop("masked @ was called"), envir = .GlobalEnv)
  # The test itself avoids `$` while it is masked.
  expect_identical(hover("sess_inspection_s4@items$a")[["str"]], capture_str("slot item"))
  rm(list = c("$", "@"), envir = .GlobalEnv)
  methods::removeClass("sess_inspection_s4", where = .GlobalEnv)

  if (requireNamespace("R6", quietly = TRUE)) {
    reads <- 0L
    Counter <- R6::R6Class(
      "sess_inspection_r6",
      public = list(field = "public"),
      active = list(
        current = function() {
          reads <<- reads + 1L
          "active"
        }
      )
    )
    global("r6", Counter$new())
    expect_identical(hover("sess_inspection_r6$field")$str, capture_str("public"))
    expect_identical(hover("sess_inspection_r6$current")$str, capture_str("active"))
    expect_identical(reads, 1L)
  }

  if (requireNamespace("S7", quietly = TRUE)) {
    Point <- S7::new_class("sess_inspection_s7", properties = list(x = S7::class_double))
    global("s7", Point(x = 3))
    expect_identical(hover("sess_inspection_s7@x")$str, capture_str(3))
  }

  # Every constant the parser produces is accepted.
  for (constant in c(
    "TRUE",
    "1.5",
    "1L",
    "1i",
    "0x10",
    "1e3",
    "Inf",
    "NaN",
    "NULL",
    "NA",
    "NA_integer_",
    "NA_character_",
    "\"text\""
  )) {
    value <- eval(parse(text = constant, keep.source = FALSE)[[1L]], baseenv())
    expect_identical(hover(constant), list(str = capture_str(value)), info = constant)
  }
  expect_false(identical(hover("NA"), hover("NULL")))
  # T and F are names, so they follow a rebinding.
  assign("T", "rebound", envir = .GlobalEnv)
  expect_identical(hover("T")$str, capture_str("rebound"))
  rm(list = "T", envir = .GlobalEnv)

  # Anything else is rejected before any binding is read.
  active <- 0L
  for (expr in c(
    "sess_inspection_active()",
    "sess_inspection_active$x()",
    "sess_inspection_active[[1]]",
    "sess_inspection_active[\"x\"]",
    "sess_inspection_active <- 1",
    "-sess_inspection_active",
    "base::sess_inspection_active",
    "sess_inspection_active; sess_inspection_active",
    "sess_inspection_active\nsess_inspection_active",
    "local(sess_inspection_active)",
    "(sess_inspection_active)",
    "1$a",
    "sess_inspection_active$1",
    "...",
    "..1",
    "",
    "sess_inspection_active$",
    "sess_inspection_active$\"\""
  )) {
    expect_true(invalid(expr), info = expr)
    expect_true(invalid(expr, "$"), info = expr)
  }
  expect_identical(active, 0L)
  # Completion without a member operator has no items and reads no binding.
  expect_null(completion("sess_inspection_active", NULL))
  expect_null(completion("sess_inspection_active", "["))
  expect_identical(active, 0L)
  expect_true(invalid(1))
  expect_true(invalid(c("a", "b")))
  expect_true(invalid(NA_character_))
  expect_true(invalid("sess_inspection_nested", 1))
  # A trailing comment is dropped by the parser and does not form a call.
  expect_identical(hover("sess_inspection_nested$a$b # note")$str, capture_str("leaf"))

  # Completion results keep the existing shape.
  expect_identical(
    completion("sess_inspection_nested", "$"),
    sess:::completion_items(list(a = list(b = "leaf")), "$")
  )
  assign(
    ".DollarNames.sess_inspection_s3",
    function(x, pattern = "") c("one", "two"),
    envir = .GlobalEnv
  )
  expect_identical(vapply(completion("sess_inspection_s3", "$"), `[[`, "", "name"), c("one", "two"))
  expect_null(completion("sess_inspection_vector", "$"))
  global("empty", list())
  expect_null(completion("sess_inspection_empty", "$"))
  expect_null(completion("sess_inspection_nested", NULL))

  # Errors and interrupts from the session's own code are not turned into results.
  makeActiveBinding("sess_inspection_failing", function() stop("binding failed"), .GlobalEnv)
  failure <- tryCatch(hover("sess_inspection_failing"), error = function(e) e)
  expect_true(inherits(failure, "error"))
  expect_false(inherits(failure, "sess_inspection_invalid"))
  assign(
    ".DollarNames.sess_inspection_s3",
    function(x, pattern = "") stop("names failed"),
    envir = .GlobalEnv
  )
  expect_error(completion("sess_inspection_s3", "$"), "names failed")
  makeActiveBinding(
    "sess_inspection_interrupted",
    function() signalCondition(structure(class = c("interrupt", "condition"), list())),
    .GlobalEnv
  )
  expect_identical(
    tryCatch(hover("sess_inspection_interrupted"), interrupt = function(e) "interrupted"),
    "interrupted"
  )
})
