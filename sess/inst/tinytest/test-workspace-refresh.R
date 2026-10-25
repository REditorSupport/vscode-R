# Automatic metadata stays structural; explicit completion may inspect class methods.
local({
  env <- sess:::.sess_env
  previous_snapshot <- env$workspace_snapshot
  previous_revision <- env$workspace_revision
  symbols <- c("workspace_refresh_custom", "workspace_refresh_frame", "workspace_refresh_env",
               "workspace_refresh_active", ".DollarNames.workspace_refresh_expensive",
               "length.workspace_refresh_expensive", "dim.workspace_refresh_expensive",
               "workspace_refresh_unknown", "workspace_refresh_large")
  previous <- mget(intersect(symbols, ls(.GlobalEnv, all.names = TRUE)), .GlobalEnv)
  on.exit({
    if (exists("workspace_refresh_active", .GlobalEnv, inherits = FALSE)) {
      rm(list = "workspace_refresh_active", envir = .GlobalEnv)
    }
    rm(list = intersect(symbols, ls(.GlobalEnv, all.names = TRUE)), envir = .GlobalEnv)
    list2env(previous, envir = .GlobalEnv)
    env$workspace_snapshot <- previous_snapshot
    env$workspace_revision <- previous_revision
  })
  inspected <- 0L
  expensive <- function(...) {
    inspected <<- inspected + 1L
    stop("automatic metadata invoked a user method")
  }
  for (method in symbols[5:7]) assign(method, expensive, .GlobalEnv)
  assign(symbols[[1L]], structure(list(a = 1L, b = 2L),
                                  class = "workspace_refresh_expensive"), .GlobalEnv)
  assign(symbols[[2L]], data.frame(a = 1:3, b = letters[1:3]), .GlobalEnv)
  reference <- new.env(parent = emptyenv())
  reference$a <- 1L
  assign(symbols[[3L]], reference, .GlobalEnv)
  makeActiveBinding(symbols[[4L]], expensive, .GlobalEnv)

  snapshot <- sess:::get_workspace_data()
  expect_identical(inspected, 0L)
  expect_identical(snapshot$globalenv[[symbols[[1L]]]]$names, c("a", "b"))
  expect_identical(snapshot$globalenv[[symbols[[1L]]]]$length, 2L)
  expect_equal(snapshot$globalenv[[symbols[[2L]]]]$dim, c(3L, 2L))
  expect_identical(snapshot$globalenv[[symbols[[2L]]]]$names, c("a", "b"))
  expect_identical(snapshot$globalenv[[symbols[[4L]]]]$type, "active_binding")
  expect_identical(sess:::get_workspace_data(snapshot$revision),
                   list(revision = snapshot$revision, unchanged = TRUE))

  # Metadata is recomputed, rather than caching by address or task callback count.
  reference$b <- 2L
  changed <- sess:::get_workspace_data(snapshot$revision)
  expect_true(changed$revision > snapshot$revision)
  expect_identical(changed$globalenv[[symbols[[3L]]]]$length, 2L)
  expect_null(changed$unchanged)
  frame <- get(symbols[[2L]], .GlobalEnv)
  frame$c <- TRUE
  assign(symbols[[2L]], frame, .GlobalEnv)
  renamed <- sess:::get_workspace_data(changed$revision)
  expect_identical(renamed$globalenv[[symbols[[2L]]]]$names, c("a", "b", "c"))
  expect_true(renamed$revision > changed$revision)

  assign(symbols[[8L]], structure(1:3, class = "workspace_refresh_expensive"), .GlobalEnv)
  unknown <- sess:::get_workspace_data()$globalenv[[symbols[[8L]]]]
  expect_null(unknown$length)
  expect_identical(unknown$str, "workspace_refresh_expensive")
  expect_identical(inspected, 0L)

  # Stripping a large classed vector's attributes must not copy its payload.
  assign(symbols[[9L]], structure(rep(1, 1000000L), class = "workspace_refresh_vector"), .GlobalEnv)
  if (isTRUE(capabilities("profmem"))) {
    profile <- tempfile()
    on.exit(unlink(profile), add = TRUE)
    Rprofmem(profile, threshold = 4000000L)
    large <- sess:::get_workspace_data()$globalenv[[symbols[[9L]]]]
    Rprofmem(NULL)
    allocations <- readLines(profile, warn = FALSE)
    expect_false(any(grepl("^[0-9]+", allocations)))
    expect_identical(large$length, 1000000L)
  }

  if (requireNamespace("data.table", quietly = TRUE)) {
    table <- data.table::data.table(a = 1L)
    assign(symbols[[2L]], table, .GlobalEnv)
    before <- sess:::get_workspace_data()
    data.table::setnames(table, "b")
    after <- sess:::get_workspace_data(before$revision)
    expect_true(after$revision > before$revision)
    expect_identical(after$globalenv[[symbols[[2L]]]]$names, "b")
  }
})
