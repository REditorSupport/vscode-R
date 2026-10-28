# Run from the repository root: Rscript --vanilla scripts/benchmark-workspace-refresh.R
# Metadata is always recomputed; unchanged replies avoid the full JSON encoding.
local({
  helpers <- new.env(parent = globalenv())
  source("sess/R/zzz.R", local = helpers)
  source("sess/R/handlers.R", local = helpers)
  encode <- function(snapshot) {
    jsonlite::toJSON(list(jsonrpc = "2.0", id = 1L, result = snapshot),
                    auto_unbox = TRUE, null = "null", force = TRUE, digits = NA)
  }
  for (n in c(1000L, 10000L)) {
    symbols <- sprintf("workspace_benchmark_%05d", seq_len(n))
    list2env(setNames(rep(list(1:10), n), symbols), envir = .GlobalEnv)
    snapshot <- helpers$get_workspace_data()
    invisible(encode(snapshot))
    snapshot <- helpers$get_workspace_data()
    full <- replicate(5L, unname(system.time(encode(helpers$get_workspace_data()))[["elapsed"]]))
    unchanged <- replicate(5L, unname(system.time(
      encode(helpers$get_workspace_data(snapshot$revision))
    )[["elapsed"]]))
    cat(jsonlite::toJSON(list(
      objects = n,
      full_median_ms = median(full) * 1000,
      unchanged_median_ms = median(unchanged) * 1000,
      full_bytes = nchar(encode(snapshot), type = "bytes"),
      unchanged_bytes = nchar(encode(helpers$get_workspace_data(snapshot$revision)), type = "bytes")
    ), auto_unbox = TRUE), "\n", sep = "")
    rm(list = symbols, envir = .GlobalEnv)
  }
})
