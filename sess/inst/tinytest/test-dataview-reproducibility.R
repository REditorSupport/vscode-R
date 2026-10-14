# Data inspection must not affect simulation, resampling, or train/test splits.
local({
  env <- sess:::.sess_env
  views <- env$dataviews
  had_seed <- exists(".Random.seed", .GlobalEnv, inherits = FALSE)
  seed <- if (had_seed) get(".Random.seed", .GlobalEnv) else NULL
  on.exit({
    env$dataviews <- views
    if (had_seed) {
      assign(".Random.seed", seed, .GlobalEnv)
    } else if (exists(".Random.seed", .GlobalEnv, inherits = FALSE)) {
      rm(".Random.seed", envir = .GlobalEnv)
    }
  }, add = TRUE)

  if (had_seed) rm(".Random.seed", envir = .GlobalEnv)
  ids <- replicate(100L, sess:::dataview_register(iris)$view_id)
  expect_equal(length(unique(ids)), 100L)
  expect_false(exists(".Random.seed", .GlobalEnv, inherits = FALSE))

  set.seed(2026)
  before <- .Random.seed
  view <- sess:::dataview_register(iris)$view_id
  sess:::handle_dataview_init(list(view_id = view))
  sess:::handle_dataview_page(list(view_id = view, startRow = 20L, endRow = 40L))
  expect_identical(.Random.seed, before)
  sess:::handle_dataview_dispose(list(view_id = view))
  expect_identical(.Random.seed, before)
})
