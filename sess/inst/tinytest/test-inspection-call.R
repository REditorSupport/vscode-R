# Inspection methods published to arf as handler calls.
local({
  ns <- asNamespace("sess")
  .sess_env <- sess:::.sess_env
  call <- sess:::inspection_call
  prefix <- "sess_inspection_call_"
  methods <- c(
    "workspace",
    "workspace_children",
    "workspace_view",
    "listview_navigate",
    "listview_view",
    "hover",
    "completion",
    "dataview_init",
    "dataview_page",
    "dataview_dispose"
  )
  json <- function(...) as.character(jsonlite::toJSON(list(...), auto_unbox = TRUE))
  invalid <- function(method, args) {
    condition <- tryCatch(call(method, args), error = function(e) e)
    inherits(condition, "sess_inspection_invalid")
  }
  decode <- function(text) jsonlite::fromJSON(text, simplifyVector = FALSE)
  library_path <- dirname(system.file(package = "sess"))
  on.exit(
    rm(list = ls(.GlobalEnv, all.names = TRUE, pattern = paste0("^", prefix)), envir = .GlobalEnv),
    add = TRUE
  )

  # The published table: exactly the ten methods, none of the socket-only
  # ones, and nothing that selects a function by name.
  expect_identical(sess:::inspection_call_methods, methods)
  expect_identical(sess:::inspection_call_namespace, "vscode-r.inspect.json")
  expect_identical(names(sess:::inspection_call_handlers()), methods)
  expect_true(all(vapply(sess:::inspection_call_handlers(), is.function, logical(1))))
  expect_false(any(
    c("interactive_stop", "plot_latest") %in% names(sess:::inspection_call_handlers())
  ))
  # The socket table reuses the shared handlers instead of defining them again.
  expect_identical(
    sort(names(sess:::inspection_handlers())),
    sort(setdiff(methods, c("hover", "completion")))
  )

  # The functions published before sess is loaded carry the same selectors.
  file <- system.file("arf", "expose-inspection.R", package = "sess")
  expect_true(nzchar(file))
  stub <- source(file, local = new.env(parent = baseenv()))$value
  published <- stub(library_path)
  expect_identical(names(published), paste0("vscode-r.inspect.json/", methods))
  expect_true(all(vapply(published, is.function, logical(1))))
  expect_true(all(vapply(published, function(f) identical(names(formals(f)), "args"), logical(1))))
  expect_false(any(grepl("interactive_stop|plot_latest", names(published))))

  # Before Interactive has started sess, and for a different sess, the
  # handlers fail with an error and never load or run anything.
  hover <- published[["vscode-r.inspect.json/hover"]]
  was_connected <- .sess_env$interactive_connected
  on.exit(.sess_env$interactive_connected <- was_connected, add = TRUE)
  .sess_env$interactive_connected <- NULL
  expect_error(hover(json(expr = "pi")), "has not started")
  .sess_env$interactive_connected <- TRUE
  expect_error(
    stub(file.path(tempdir(), "other-library"))[[1L]](json(expr = "pi")),
    "not the Interactive"
  )
  expect_identical(decode(hover(json(expr = "pi")))$result$str, sess:::capture_str(pi))
  .sess_env$interactive_connected <- was_connected

  # A fresh R process has not loaded sess: the handler reports that, and the
  # attempt does not load it.
  rscript <- file.path(R.home("bin"), "Rscript")
  if (file.exists(rscript)) {
    code <- sprintf(
      paste0(
        "handlers <- base::source(%s, local = base::new.env(parent = base::baseenv()))$value(%s);",
        "message <- tryCatch(handlers[[1L]]('{}'), error = function(e) conditionMessage(e));",
        "cat(message, 'loaded:', 'sess' %%in%% loadedNamespaces(), sep = '|')"
      ),
      deparse(file),
      deparse(library_path)
    )
    output <- system2(
      rscript,
      c("--vanilla", "-e", shQuote(code)),
      env = paste0("R_LIBS=", paste(.libPaths(), collapse = .Platform$path.sep)),
      stdout = TRUE,
      stderr = TRUE
    )
    expect_identical(output, "The Interactive runtime has not been loaded yet|loaded:|FALSE")
  }

  # Argument validation does not depend on the client.
  expect_true(invalid("nonexistent", "{}"))
  expect_true(invalid("interactive_stop", "{}"))
  expect_true(invalid("plot_latest", "{}"))
  expect_true(invalid(NA_character_, "{}"))
  expect_true(invalid(c("hover", "hover"), "{}"))
  # Arguments that are not one string holding a JSON object.
  for (args in list(NULL, NA_character_, 1L, c("{}", "{}"), list(expr = "x"))) {
    expect_true(invalid("hover", args))
  }
  expect_true(invalid("hover", "{"))
  expect_true(invalid("hover", "[]"))
  expect_true(invalid("hover", "[1]"))
  expect_true(invalid("hover", '"expr"'))
  expect_true(invalid("hover", "null"))
  # Required fields and field types.
  expect_true(invalid("hover", "{}"))
  expect_true(invalid("hover", json(expr = NULL)))
  expect_true(invalid("hover", json(expr = 1L)))
  expect_true(invalid("hover", json(expr = c("a", "b"))))
  expect_true(invalid("hover", json(expr = list("a"))))
  expect_true(invalid("hover", json(expr = TRUE)))
  expect_true(invalid("completion", json(expr = "x", trigger = 1L)))
  expect_true(invalid("completion", json(expr = "x", trigger = c("$", "@"))))
  expect_true(invalid("workspace", json(revision = "1")))
  expect_true(invalid("workspace", json(revision = c(1, 2))))
  expect_true(invalid("workspace_children", "{}"))
  expect_true(invalid("workspace_children", json(name = "x", start = 0L)))
  expect_true(invalid("workspace_children", json(name = "x", start = 1.5)))
  expect_true(invalid("workspace_children", json(name = "x", start = "1")))
  expect_true(invalid("workspace_children", json(name = 1L)))
  expect_true(invalid("workspace_children", json(name = "x", path = "a")))
  expect_true(invalid("workspace_children", json(name = "x", path = list(1L))))
  expect_true(invalid(
    "workspace_children",
    json(name = "x", path = list(list(kind = "call", value = "f")))
  ))
  expect_true(invalid(
    "workspace_children",
    json(name = "x", path = list(list(kind = "name", value = "")))
  ))
  expect_true(invalid(
    "workspace_children",
    json(name = "x", path = list(list(kind = "index", value = 0L)))
  ))
  expect_true(invalid("workspace_children", json(name = "x", path = list(list(kind = "slot")))))
  # A list view is addressed by indices, not selectors.
  expect_true(invalid(
    "workspace_children",
    json(view_id = "v", path = list(list(kind = "index", value = 1L)))
  ))
  expect_true(invalid("workspace_children", json(view_id = "v", path = list(0L))))
  expect_true(invalid("workspace_view", "{}"))
  expect_true(invalid("workspace_view", json(name = "x", path = list("a"))))
  expect_true(invalid("listview_navigate", "{}"))
  expect_true(invalid("listview_navigate", json(view_id = "v", path = list("a"))))
  expect_true(invalid("listview_navigate", json(view_id = "v", path = list(-1L))))
  expect_true(invalid("listview_view", json(view_id = "v", path = list(1L))))
  expect_true(invalid("listview_view", json(view_id = "v", index = 0L)))
  expect_true(invalid("listview_view", json(view_id = "v", index = "1")))
  expect_true(invalid("dataview_init", "{}"))
  expect_true(invalid("dataview_init", json(view_id = list("a"))))
  expect_true(invalid("dataview_page", json(view_id = "v", startRow = "0")))
  expect_true(invalid("dataview_page", json(view_id = "v", endRow = c(1, 2))))
  expect_true(invalid("dataview_page", json(view_id = "v", sortModel = "asc")))
  expect_true(invalid("dataview_page", json(view_id = "v", filterModel = 1L)))
  expect_true(invalid("dataview_page", json(view_id = "v", formatNumbers = "yes")))
  expect_true(invalid("dataview_dispose", "{}"))
  expect_true(invalid("dataview_dispose", json(view_id = "v", state_generation = "1")))

  # Valid arguments pass validation, and only the fields that a method reads
  # reach its handler.
  validate <- sess:::inspection_validate
  expect_length(validate("workspace", decode("{}")), 0L)
  expect_identical(validate("workspace", decode('{"revision":3}')), list(revision = 3L))
  expect_identical(
    validate("workspace_children", decode('{"name":"x","extra":true}')),
    list(name = "x", path = list(), start = 1L)
  )
  expect_identical(
    validate("workspace_children", decode('{"view_id":"v","path":[1,2],"start":3}'))$path,
    list(1L, 2L)
  )
  expect_identical(names(validate("completion", decode('{"expr":"x"}'))), "expr")
  expect_identical(
    validate("listview_view", decode('{"view_id":"v","index":2,"unused":1}')),
    list(view_id = "v", path = list(), index = 2L)
  )
  expect_identical(
    sort(names(validate(
      "dataview_page",
      decode(
        '{"view_id":"v","startRow":0,"endRow":10,"sortModel":[],"filterModel":{},"formatNumbers":true}'
      )
    ))),
    sort(c("view_id", "startRow", "endRow", "sortModel", "filterModel", "formatNumbers"))
  )
  # A JSON null is an absent optional field.
  expect_length(validate("workspace", decode('{"revision":null}')), 0L)

  # Results encode like a socket reply: the same R value decodes to the same
  # JSON value, and a NULL result stays distinct from NA.
  pipe <- processx::conn_create_pipepair()
  orig_con <- .sess_env$con
  on.exit(
    {
      .sess_env$con <- orig_con
      lapply(pipe, close)
    },
    add = TRUE
  )
  .sess_env$con <- pipe[[2L]]
  socket_result <- function(result) {
    sess:::rpc_reply("reply", result)
    reply <- decode(processx::conn_read_chars(pipe[[1L]]))
    list(present = "result" %in% names(reply), value = reply$result)
  }
  call_result <- function(result) {
    encoded <- sess:::inspection_encode(result)
    expect_true(is.character(encoded) && length(encoded) == 1L && is.null(attributes(encoded)))
    reply <- decode(encoded)
    list(present = "result" %in% names(reply), value = reply$result)
  }
  results <- list(
    null = NULL,
    na = NA,
    na_character = NA_character_,
    na_integer = NA_integer_,
    flag = TRUE,
    number = 1.5,
    integer = 3L,
    string = "text",
    unicode = "café あ\U0001F600",
    quotes = "a \"quoted\" \\ value\n",
    empty_string = "",
    empty_vector = character(0),
    empty_integer = integer(0),
    empty_list = list(),
    empty_object = structure(list(), names = character()),
    vector = c(1L, 2L, 3L),
    named_vector = c(a = 1, b = 2),
    nested = list(a = list(b = list(1, "two", NULL)), c = I(1L)),
    na_inside = list(a = NA, b = c(1, NA), c = c("x", NA)),
    nan = NaN,
    infinite = c(Inf, -Inf),
    special = list(nan = NaN, inf = Inf, ninf = -Inf, na = NA_real_),
    large = 1e300,
    precise = 0.1 + 0.2,
    list_of_lists = list(list(a = 1), list(a = 2)),
    factor = factor(c("a", "b")),
    date = as.Date("2026-01-02"),
    frame = data.frame(x = 1:2, y = c("a", NA)),
    unchanged = list(revision = 3, unchanged = TRUE)
  )
  for (name in names(results)) {
    expect_identical(call_result(results[[name]]), socket_result(results[[name]]), info = name)
  }
  # A list holding NULL is not NULL.
  expect_identical(call_result(list(NULL))$present, TRUE)
  expect_identical(call_result(NULL), list(present = FALSE, value = NULL))
  expect_null(call_result(NA)$value)
  expect_true(call_result(NA)$present)
  # Encoded results are bounded below the client's frame limit.
  expect_error(sess:::inspection_encode(strrep("a", 5L * 1024L * 1024L)), "size limit")

  # The same request gives the same result on both transports.
  view_id <- sess:::dataview_register(data.frame(value = 1:3, label = c("a", "b", NA)))$view_id
  on.exit(.sess_env$dataviews[[view_id]] <- NULL, add = TRUE)
  socket <- function(method, params) {
    sess:::dispatch_message(as.character(jsonlite::toJSON(
      list(jsonrpc = "2.0", id = "request", method = method, params = params),
      auto_unbox = TRUE
    )))
    decode(processx::conn_read_chars(pipe[[1L]]))$result
  }
  assign("sess_inspection_call_children", list(first = 1L, second = list(3L)), envir = .GlobalEnv)
  requests <- list(
    list("dataview_init", list(view_id = view_id)),
    list("dataview_page", list(view_id = view_id, startRow = 0L, endRow = 2L)),
    list(
      "dataview_page",
      list(view_id = view_id, startRow = 1L, endRow = 5L, formatNumbers = TRUE)
    ),
    list(
      "dataview_page",
      list(view_id = view_id, sortModel = list(list(colId = "1", sort = "desc")))
    ),
    list("workspace_children", list(name = "sess_inspection_call_children")),
    list("dataview_dispose", list(view_id = "unknown"))
  )
  for (request in requests) {
    method <- request[[1L]]
    params <- do.call(json, request[[2L]])
    expect_identical(
      decode(call(method, params))$result,
      socket(method, request[[2L]]),
      info = method
    )
  }

  # Hover and completion resolve names and member chains without evaluating
  # the request text.
  marker <- paste0(prefix, "evaluated")
  assign(paste0(prefix, "value"), list(a = 1L, b = "x"), envir = .GlobalEnv)
  hovered <- decode(call("hover", json(expr = paste0(prefix, "value"))))
  expect_identical(hovered$result$str, sess:::capture_str(list(a = 1L, b = "x")))
  hovered <- decode(call("hover", json(expr = paste0(prefix, "value$a"))))
  expect_identical(hovered$result$str, sess:::capture_str(1L))
  expect_false("result" %in% names(decode(call("hover", json(expr = paste0(prefix, "absent"))))))
  completed <- decode(call("completion", json(expr = paste0(prefix, "value"), trigger = "$")))
  expect_identical(vapply(completed$result, function(item) item$name, character(1)), c("a", "b"))
  expect_false("result" %in% names(decode(call("completion", json(expr = "pi")))))
  assignment <- paste0("assign('", marker, "', TRUE, envir = .GlobalEnv)")
  for (expr in c(
    assignment,
    paste0("local(", assignment, ")"),
    paste0("repeat ", prefix, "value"),
    paste0(prefix, "value[[1]]"),
    paste0(prefix, "value; ", assignment),
    paste0("(", assignment, ")"),
    "base::pi",
    "-1",
    "if (TRUE) 1",
    "{",
    ""
  )) {
    expect_true(invalid("hover", json(expr = expr)), info = expr)
    expect_true(invalid("completion", json(expr = expr, trigger = "$")), info = expr)
  }
  expect_false(exists(marker, envir = .GlobalEnv, inherits = FALSE))
  # Completion on an expression without an accessor reads nothing.
  makeActiveBinding(
    paste0(prefix, "touched"),
    function() {
      assign(marker, TRUE, envir = .GlobalEnv)
      list(a = 1L)
    },
    .GlobalEnv
  )
  call("completion", json(expr = paste0(prefix, "touched")))
  expect_false(exists(marker, envir = .GlobalEnv, inherits = FALSE))

  # Errors and interrupts propagate: neither becomes a successful value.
  makeActiveBinding(
    paste0(prefix, "fails"),
    function() stop("binding failed", call. = FALSE),
    .GlobalEnv
  )
  makeActiveBinding(
    paste0(prefix, "interrupts"),
    function() signalCondition(structure(class = c("interrupt", "condition"), list())),
    .GlobalEnv
  )
  for (method in c("hover", "completion")) {
    for (name in c("fails", "interrupts")) {
      expr <- paste0(prefix, name)
      args <- if (method == "hover") json(expr = expr) else json(expr = expr, trigger = "$")
      value <- tryCatch(
        call(method, args),
        error = function(e) paste("error:", conditionMessage(e)),
        interrupt = function(e) "interrupt"
      )
      expect_identical(
        value,
        if (name == "fails") "error: binding failed" else "interrupt",
        info = paste(method, name)
      )
    }
  }
  unknown <- tryCatch(call("dataview_init", json(view_id = "unknown")), error = function(e) e)
  expect_true(inherits(unknown, "error"))
  expect_true(grepl("Unknown dataview id", conditionMessage(unknown), fixed = TRUE))
  # Validation errors have their own class; other errors do not.
  expect_false(inherits(unknown, "sess_inspection_invalid"))
  expect_true(inherits(
    tryCatch(call("dataview_init", "{}"), error = function(e) e),
    "sess_inspection_invalid"
  ))
  # A result that cannot be encoded is an error, too.
  .sess_env$dataviews[[view_id]]$columns[[2L]]$headerTooltip <- 1 + 2i
  expect_error(suppressWarnings(call("dataview_init", json(view_id = view_id))))
})
