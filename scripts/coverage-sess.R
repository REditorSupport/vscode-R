# Run from the repository root after node scripts/prepare-sess.js.
if (!requireNamespace("covr", quietly = TRUE) || utils::packageVersion("covr") != "4.0.0") {
  stop("sess coverage requires covr 4.0.0; see CONTRIBUTING.md for setup instructions.")
}
# The package's test runner skips tests when tinytest is absent.
for (package in c("tinytest", "htmltools", "xml2")) {
  loadNamespace(package)
}

output_dir <- file.path("dist", "coverage", "sess")
unlink(output_dir, recursive = TRUE)
dir.create(output_dir, recursive = TRUE)
coverage <- covr::package_coverage(
  path = file.path("dist", "resources", "sess"),
  type = "tests",
  outDir = file.path(normalizePath(output_dir), "tests"),
  allow_failures = FALSE
)
print(coverage)
saveRDS(coverage, file.path(output_dir, "coverage.rds"))
covr::cobertura(coverage, file = file.path(output_dir, "cobertura.xml"))
covr::report(coverage, file = file.path(output_dir, "report.html"), browse = FALSE)

summary <- sprintf(
  "sess line coverage (covr 4.0.0): %.2f%%\n\nSee the sess-coverage artifact for the HTML report, coverage data and test logs.\n",
  covr::percent_coverage(coverage, by = "line")
)
cat(summary)
summary_file <- Sys.getenv("GITHUB_STEP_SUMMARY")
if (nzchar(summary_file)) {
  cat(summary, file = summary_file, append = TRUE)
}
