# The socket session's hover and completion handlers use the inspection
# resolver: requests they used to answer give the same results, and other
# requests give no result without being evaluated.
local({
  hover <- sess:::handle_hover
  complete <- sess:::handle_complete
  capture_str <- sess:::capture_str
  completion_items <- sess:::completion_items
  prefix <- "sess_hover_"
  masked <- c("$.sess_hover_s3", ".DollarNames.sess_hover_s3")
  saved <- mget(intersect(masked, ls(.GlobalEnv, all.names = TRUE)), envir = .GlobalEnv)
  on.exit({
    rm(list = ls(.GlobalEnv, all.names = TRUE, pattern = paste0("^", prefix)), envir = .GlobalEnv)
    rm(list = intersect(masked, ls(.GlobalEnv, all.names = TRUE)), envir = .GlobalEnv)
    list2env(saved, envir = .GlobalEnv)
  })
  global <- function(name, value) {
    assign(paste0(prefix, name), value, envir = .GlobalEnv)
  }

  global("df", data.frame(x = 1:3, y = letters[1:3]))
  global("list", list(a = list(b = "leaf"), c = 1))
  global("env", list2env(list(one = 1, two = "2")))
  global("s3", structure(list(), class = "sess_hover_s3"))
  assign("$.sess_hover_s3", function(x, name) paste("member", name), envir = .GlobalEnv)
  assign(".DollarNames.sess_hover_s3", function(x, pattern = "") c("p", "q"), envir = .GlobalEnv)
  methods::setClass(
    "sess_hover_s4",
    representation(items = "list", label = "character"),
    where = .GlobalEnv
  )
  on.exit(methods::removeClass("sess_hover_s4", where = .GlobalEnv), add = TRUE)
  global("s4", methods::new("sess_hover_s4", items = list(a = 1), label = "s4"))

  # These requests previously went through eval(); the results are unchanged.
  previous <- function(expr) {
    eval(parse(text = expr, keep.source = FALSE)[[1L]], .GlobalEnv)
  }
  same <- function(expr, trigger = NULL) {
    expect_identical(hover(expr), list(str = capture_str(previous(expr))), info = expr)
    if (!is.null(trigger)) {
      expect_identical(
        complete(expr, trigger),
        completion_items(previous(expr), trigger),
        info = expr
      )
    }
  }
  same("sess_hover_df", "$")
  same("sess_hover_df$x")
  same("sess_hover_list", "$")
  same("sess_hover_list $ a", "$")
  same("sess_hover_list$a$b")
  same("sess_hover_env", "$")
  same("sess_hover_env$two")
  same("sess_hover_s3", "$")
  same("sess_hover_s3$p")
  same("sess_hover_s4", "@")
  same("sess_hover_s4@items", "$")
  same("pi")
  for (constant in c("1", "1.5", "1L", "TRUE", "NULL", "NA", "0x10", "\"text\"")) {
    same(constant)
  }
  if (requireNamespace("data.table", quietly = TRUE)) {
    global("dt", data.table::data.table(id = 1:2, value = c("a", "b")))
    same("sess_hover_dt", "$")
    same("sess_hover_dt$value")
  }
  if (requireNamespace("R6", quietly = TRUE)) {
    Counter <- R6::R6Class(
      "SessHoverCounter",
      public = list(count = 1, add = function() invisible(self)),
      active = list(double = function() self$count * 2)
    )
    global("r6", Counter$new())
    same("sess_hover_r6", "$")
    same("sess_hover_r6$double")
  }

  # Missing names and members give no result, as before.
  expect_null(hover("sess_hover_missing"))
  expect_null(complete("sess_hover_missing", "$"))
  expect_null(complete("sess_hover_df", NULL))

  # Other requests give no result, and the request text is not evaluated.
  # Control flow is rejected: hovering `x` in `repeat x <- x + 1` sends
  # `repeat x`, which used to loop forever. `repeat break` fails instead of
  # hanging if it is evaluated again.
  rejected <- c(
    "repeat break",
    "sess_hover_called <- TRUE",
    "assign(\"sess_hover_called\", TRUE)",
    "sess_hover_list; sess_hover_called <- TRUE",
    "(sess_hover_called <- TRUE)$a",
    "sess_hover_list$a("
  )
  for (expr in rejected) {
    expect_null(hover(expr), info = expr)
    expect_null(complete(expr, "$"), info = expr)
  }
  expect_false(exists("sess_hover_called", envir = .GlobalEnv))
  expect_null(complete("get(\"sess_hover_list\")", "$"))

  # Errors from the session's own code give no result; interrupts propagate.
  makeActiveBinding("sess_hover_failing", function() stop("binding failed"), .GlobalEnv)
  expect_null(hover("sess_hover_failing"))
  assign(".DollarNames.sess_hover_s3", function(x, pattern = "") stop("names failed"), .GlobalEnv)
  expect_null(complete("sess_hover_s3", "$"))
  makeActiveBinding(
    "sess_hover_interrupted",
    function() signalCondition(structure(class = c("interrupt", "condition"), list())),
    .GlobalEnv
  )
  expect_identical(
    tryCatch(hover("sess_hover_interrupted"), interrupt = function(e) "interrupted"),
    "interrupted"
  )
  expect_identical(
    tryCatch(complete("sess_hover_interrupted", "$"), interrupt = function(e) "interrupted"),
    "interrupted"
  )
})
