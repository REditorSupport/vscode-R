# R reuses graphics device numbers after dev.off(). A new registration must
# replace the previous lifetime without removing other live device identities.
local({
  original_devices <- grDevices::dev.list()
  on.exit({
    for (id in rev(setdiff(grDevices::dev.list(), original_devices))) {
      try(grDevices::dev.off(id), silent = TRUE)
    }
  }, add = TRUE)

  state <- new.env(parent = emptyenv())
  state$devices <- list()
  env <- new.env(parent = asNamespace("sess"))
  env$.runtime_state <- function() state
  track <- sess:::.runtime_track_device
  environment(track) <- env

  grDevices::pdf(NULL)
  track()
  state$devices[[1L]]$key <- "other-live-device"
  other <- state$devices[[1L]]

  grDevices::pdf(NULL)
  id <- grDevices::dev.cur()
  track()
  state$devices[[2L]]$key <- "closed-device"
  grDevices::dev.off(id)
  grDevices::pdf(NULL)
  expect_identical(grDevices::dev.cur(), id)
  track()

  expect_length(state$devices, 2L)
  expect_identical(state$devices[[1L]], other)
  expect_identical(state$devices[[2L]]$id, unname(id))
  expect_null(state$devices[[2L]]$key)
})
