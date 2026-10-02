# R analysis examples

`public.json` records public source URLs, the exercised code, adaptations, and expected rich-output types. Examples use built-in datasets and do not download data or install packages. The runner creates a disposable session and private bridge runtime, verifies execution and output types, saves events/assets, exports widget bundles, and renders independent ordinary-R PNG references for visual comparison. It closes its session afterward.

From the repository root, install the normal Interactive test dependencies plus `ggplot2`, `dplyr`, `DT`, and `plotly` into a test library, then run:

```sh
R_LIBS=/path/to/test-library npm run test:interactive:examples
```

`VSCR_EXAMPLE_OUTPUT` selects the result directory (otherwise a new temporary directory is printed). Use a fresh directory for each run. Set `VSCR_TEST_PROVIDER=arf` and optionally `ARF_PATH` for arf, or `VSCR_TEST_STATIC=1` for standard graphics. JGD runs need `jgd` and `systemfonts`; the standard backend uses `svglite`, falling back to PNG.

`public-more.json` adds fourteen cases sourced from the public R manuals: PCA, matrix-valued grouped summaries, k-means, ARIMA with missing observations, nonlinear regression, Holt-Winters forecasting, STL decomposition, rotated/reflected rasters, marginal histograms, filled contours, grid pages, lattice panels, and text progress output. Source URLs and adaptations are recorded in each fixture. These require only R's standard/recommended packages plus the selected graphics backend. Run them with `VSCR_EXAMPLE_SUITE=public-more`.

`research.json` adds twelve end-to-end research workflows: CSV import and cleaning, data.table joins/reshape, dplyr/tidyr summaries, descriptive statistics and tests, linear and logistic regression, bootstrap reproducibility, paged model diagnostics, faceted plots, survival analysis, file/model export, and a 100,000-row table. These use built-in data and assert numerical results, output kinds, printed model summaries, and diagnostic page counts. Install `data.table`, `ggplot2`, `dplyr`, `tidyr`, `survival`, and `svglite` in the test library, then run:

```sh
R_LIBS=/path/to/test-library VSCR_EXAMPLE_SUITE=research npm run test:interactive:examples
```

The same provider/backend variables apply to all suites. When testing in parallel, compile once first and invoke `node src/test/examples/run.cjs` directly; do not rebuild assets while another test is using them. Cases share a disposable R session, as in a continuing analysis. Their files stay in its temporary working directory and are removed afterward. The recorded timings include polling and a 350 ms output-settle delay; they are not execution benchmarks.

Each case writes `code.R`, `events.json`, and `outputs.json`, plus every retained plot page (`interactive-01.svg`, etc.), the final `interactive.svg`/PNG, and ordinary-R reference PNGs. Local asset reads support dense plots larger than the agent's small-asset RPC limit. Artifacts are saved before output assertions so failed cases remain inspectable. `results.json` records timing, output types, conditions, and exported widget locations. Compare corresponding plot pages; rendering libraries and antialiasing can differ, so this is a visual comparison, not a pixel-equality assertion. Font/layout references use the default JGD resolution of 96 DPI; the standard SVG backend uses point units.

For widgets, serve the exported bundle with `AssetStore` and embed it in an iframe with `sandbox="allow-scripts allow-forms allow-downloads"`, matching the Interactive renderer. Verify DT search/sort/paging and Plotly hover/zoom/reset in a browser. An execution success alone does not verify browser interaction.

The separate `interactiveLibraries.test.ts` suite requires `renv`. It installs tiny local fixture packages only in temporary libraries and tests ordinary startup paths, default installation, renv isolation, snapshot, and offline restore with both session providers. CI installs renv before this suite.

See [the validation report](../../../docs/r-interactive-public-examples.md) for the recorded results and limits.
See also [the research review](../../../docs/r-interactive-research-review.md) for workflow coverage and fixes found through native Interactive use.
