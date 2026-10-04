# R analysis examples

`public.json` records public source URLs, the exercised code, adaptations, and expected rich-output types. Examples use built-in datasets and do not download data or install packages. The runner creates a disposable session and private bridge runtime, verifies execution and output types, saves events/assets, exports widget bundles, and renders independent ordinary-R PNG references for visual comparison. It closes its session afterward.

From the repository root, install the [Interactive test dependencies](../../../CONTRIBUTING.md#testing-r-interactive) plus `ggplot2`, `dplyr`, `DT`, and `plotly` into a test library, then run:

```sh
R_LIBS=/path/to/test-library pnpm run test:interactive:examples
```

`VSCR_EXAMPLE_OUTPUT` selects the result directory (otherwise a new temporary directory is printed). Use a fresh directory for each run. Set `VSCR_TEST_PROVIDER=arf` and optionally `ARF_PATH` for arf, or `VSCR_TEST_STATIC=1` for standard graphics. JGD runs need `jgd` and `systemfonts`; the standard backend uses `svglite`, falling back to PNG.

`public-more.json` adds fourteen cases sourced from the public R manuals: PCA, matrix-valued grouped summaries, k-means, ARIMA with missing observations, nonlinear regression, Holt-Winters forecasting, STL decomposition, rotated/reflected rasters, marginal histograms, filled contours, grid pages, lattice panels, and text progress output. Source URLs and adaptations are recorded in each fixture. These require only R's standard/recommended packages plus the selected graphics backend. Run them with `VSCR_EXAMPLE_SUITE=public-more`.

`research.json` adds twelve end-to-end research workflows: CSV import and cleaning, data.table joins/reshape, dplyr/tidyr summaries, descriptive statistics and tests, linear and logistic regression, bootstrap reproducibility, paged model diagnostics, faceted plots, survival analysis, file/model export, and a 100,000-row table. These use built-in data and assert numerical results, output kinds, printed model summaries, and diagnostic page counts. Install `data.table`, `ggplot2`, `dplyr`, `tidyr`, `survival`, and `svglite` in the test library, then run:

```sh
R_LIBS=/path/to/test-library VSCR_EXAMPLE_SUITE=research pnpm run test:interactive:examples
```

The same provider/backend variables apply to all suites. When testing in parallel, compile once first and invoke `node src/test/examples/run.cjs` directly; do not rebuild assets while another test is using them. Cases share a disposable R session, as in a continuing analysis. Their files stay in its temporary working directory and are removed afterward. The recorded timings include polling and a 350 ms output-settle delay; they are not execution benchmarks.

Each case writes `code.R`, `events.json`, and `outputs.json`, plus every retained plot page (`interactive-01.svg`, etc.), the final `interactive.svg`/PNG, and ordinary-R reference PNGs. Local asset reads support dense plots larger than the agent's small-asset RPC limit. Artifacts are saved before output assertions so failed cases remain inspectable. `results.json` records timing, output types, conditions, and exported widget locations. Compare corresponding plot pages; rendering libraries and antialiasing can differ, so this is a visual comparison, not a pixel-equality assertion. Font/layout references use the default JGD resolution of 96 DPI; the standard SVG backend uses point units.

For widgets, serve the exported bundle with `AssetStore` and embed it in an iframe with `sandbox="allow-scripts allow-forms allow-downloads"`, matching the Interactive renderer. Verify DT search/sort/paging and Plotly hover/zoom/reset in a browser. An execution success alone does not verify browser interaction.

The separate `interactiveLibraries.test.ts` suite requires `renv`. It installs tiny local fixture packages only in temporary libraries and tests ordinary startup paths, default installation, renv isolation, snapshot, and offline restore with both session providers. CI installs renv before this suite.

## Editor runtime lifecycle

After `pnpm run pretest`, `runtime-lifecycle.cjs` launches isolated VS Code test instances and checks that a real R session remains reachable after the application exits. It then reopens VS Code, verifies the same R PID and saved objects, and creates another session using the current editor runtime. No standalone Node executable is exposed to the agent launcher through PATH. Test profiles, libraries, and sessions are temporary.

Pass one editor executable to test quit/reopen, or two versions to also test reconnection after switching editor versions:

```sh
R_LIBS=/path/to/test-library pnpm exec node src/test/examples/runtime-lifecycle.cjs \
  /path/to/older/VSCode /path/to/newer/VSCode
```

The second case exercises reconnecting and launching across versions; it does not run the editor's updater or prove that every platform's update mechanism preserves running agents. On macOS, use the app's `Contents/MacOS/Code` executable. The fixture needs the normal Interactive R dependencies and the R Syntax extension in `.vscode-test/extensions`.

## Large-table allocation checks

[`large-table.R`](large-table.R) measures row subsetting, handle registration, page formatting, class printing, and JSON encoding. Install this checkout's `sess` into a disposable test library, along with `data.table`, then run:

```sh
R_LIBS=/path/to/test-library Rscript src/test/examples/large-table.R
```

R must support memory profiling (`capabilities("profmem")`). The script checks that no single bounded-preview allocation reaches 8 MiB and exercises first/last-page access. The 2-million-row dense data.table uses about 351 MiB before temporary copies; allow additional memory for the comparison. The 832,976,871-row fixture uses compact ALTREP integer columns and does not represent the cost of allocating a dense table of that size. Timings measure the local R path, excluding editor rendering and Remote SSH transport.

## Historical results

The [public-example report](https://github.com/REditorSupport/vscode-R/blob/c2167d2cdb403375fa10ad3e29cde73a49cfc014/docs/r-interactive-public-examples.md), [research workflow review](https://github.com/REditorSupport/vscode-R/blob/c2167d2cdb403375fa10ad3e29cde73a49cfc014/docs/r-interactive-research-review.md), and [large-table measurements](https://github.com/REditorSupport/vscode-R/blob/c2167d2cdb403375fa10ad3e29cde73a49cfc014/docs/r-interactive-large-tables.md) record results from development of [PR #1805](https://github.com/REditorSupport/vscode-R/pull/1805). They are archived at a fixed revision; use the current fixtures and CI for current results.
