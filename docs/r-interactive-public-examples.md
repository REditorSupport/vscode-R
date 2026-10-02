# Public-example and library validation

The October 1, 2026 pass used macOS, R 4.6.1, VS Code 1.140.0, arf 0.5.1, renv 1.3.0, jgd 0.2.0, systemfonts 1.3.2, svglite 2.2.2, ggplot2 4.0.3, dplyr 1.2.1, DT 0.34.0, and plotly 4.12.1. Missing test dependencies were installed in a temporary library. Existing user libraries and sessions were not modified.

## Library behavior

The private bridge library previously came first in both `R_LIBS` and `.libPaths()`. That incorrectly made it the default installation destination and inserted it into renv projects. The shared R/arf bootstrap now loads the private bridge explicitly without changing either setting. Project versions of support dependencies take precedence over fallback host libraries.

Real R and arf tests verify startup `.libPaths()` and all three `R_LIBS*` variables remain identical, a local package installs into the first normal library, and the private bridge never receives it. The renv case additionally verifies that an unrelated user-library package remains hidden, installation uses the project library, snapshots exclude the bridge, and a recorded local-source package restores offline after removal from the project library. Plotting and subsequent evaluation remain usable.

The arf test also exercises profile output before the headless JSON readiness record. The launcher now consumes ordinary text and unrelated JSON lines while waiting for the actual socket record, allowing renv startup banners without a startup failure.

Linux CI additionally exposed `processx` loading `ps` lazily during namespace startup. The bridge now explicitly preloads that dependency too. The isolated-project regression checks a real `ps` call and verifies it does not enter the project lockfile.

## Public examples

All ten examples completed through plain R + JGD, arf + JGD, and plain R + standard graphics: **30 successful executions**. Checks compare the complete set of display types, so unexpected copies of previous plots are failures as well as missing output. Source and adaptation details are retained in [the runnable fixtures](../src/test/examples/public.json).

| Public source | Expected output and checks |
| --- | --- |
| [Gallery iris scatter](https://r-graph-gallery.com/272-basic-scatterplot-with-ggplot2.html) | Static scatterplot; points, axes, grid, and labels |
| [Gallery scatter with rug](https://r-graph-gallery.com/276-scatterplot-with-rug-ggplot2.html) | Rich `head(iris)` table and plot; alpha rug marks |
| [Gallery clustered heatmap](https://r-graph-gallery.com/215-the-heatmap-function.html) | Base-graphics heatmap; dendrograms and rotated labels |
| [Gallery polynomial interval](https://r-graph-gallery.com/45-confidence-interval-around-polynomial-curve-fitting.html) | Model fit, line, and transparent prediction polygon |
| [Gallery four panels](https://r-graph-gallery.com/71-split-screen-with-par-mfrow.html) | Two scatterplots, histogram, and boxplot; panel axes and labels |
| [Gallery tile heatmap](https://r-graph-gallery.com/79-levelplot-with-ggplot2.html) | 400 tiles and a correctly sized colour bar |
| [ggplot2 raster density](https://ggplot2.tidyverse.org/reference/geom_tile.html) | Faithful density raster fills its intended rectangle; colour bar and labels |
| [dplyr grouped summary](https://dplyr.tidyverse.org/reference/summarise.html) | Three-row table; group counts 11, 7, 14, totaling 32 |
| [DT iris table](https://rstudio.github.io/DT/) | HTML widget; search, numeric sort, and paging |
| [Gallery interactive heatmap](https://r-graph-gallery.com/79-levelplot-with-ggplot2.html) | Plotly HTML widget; tooltip, zoom, and reset |

The gallery rug example emits ggplot2's expected `size` → `linewidth` deprecation warning, and `predict.lm()` emits its expected future-response warning. Package attachment/masking messages remain ordinary R output. The runner fixes the RNG seed and resets graphics parameters for plotting examples; Plotly uses `theme_minimal()` instead of the tutorial's optional theme package.

## Rendering and interaction findings

Seven retained JGD SVGs were rasterized and compared visually against independent ordinary-R PNG renders at 800 × 600 and 96 DPI. This exposed two defects that execution-only checks missed:

- SVG raster images preserved their bitmap aspect ratio, narrowing density images and collapsing colour bars. `preserveAspectRatio="none"` now fills the rectangle requested by R.
- JGD specifies font sizes in points, but the renderer and metrics process treated them as pixels. SVG text and font measurements now convert using device DPI. Twelve-point text uses 16 device pixels at the default 96 DPI.

The corrected plots preserve the expected geometry, labels, panel arrangement, and legends. Regression tests cover narrow rasters, multiple font resolutions, per-device metrics, and real R font widths. Antialiasing, font engines, and colour management still produce minor differences from native PNG output; comparisons do not claim pixel identity.

Exported DT and Plotly bundles were served through the actual agent asset service and exercised inside the same iframe sandbox as Interactive. DT filtered 150 iris rows to 50 versicolor rows, sorted sepal length numerically, and paged to rows 11–20. Plotly zoom narrowed the axes from A–T to F–O, reset restored the full range, and a tile tooltip displayed `x: K`, `y: var11`, `Value: 2.71`. No browser warning/error logs were observed. The exported widgets remained usable after their R sessions had stopped.

## Final regression results

| Check | Result |
| --- | --- |
| Full extension suite, VS Code 1.140.0, tmux enabled | 396 passed |
| arf runtime and library suite | 30 passed |
| Standard graphics runtime and library suite | 21 passed, 9 optional/JGD cases skipped |
| Public examples across three configurations | 30 passed |
| Bundled sess package | 430 checks passed |
| TypeScript, production build, and R lint | Passed |
| TypeScript lint | No errors; 70 existing warnings |

One initial full-suite renv install exceeded the 20-second cell deadline. The isolated test and full rerun both completed in about three seconds; package-install checks now allow 60 seconds for slower runners. No fixture packages were installed in the user's library.

## Limits

JGD's metrics request does not include DPI. The server uses the default 96 DPI until the first frame reports the device resolution, then tracks it per connection. Custom devices requesting metrics before their first frame remain subject to that protocol limitation. This pass did not exercise actual Remote SSH transport, network-dependent widgets, or every R graphics extension.

See [the runner instructions](../src/test/examples/README.md) to repeat the matrix. Start a new Interactive session after updating to use the new bootstrap and agent SVG writer. Old persistent agents and retained SVG files do not hot-update.

## October 2: additional public R manual examples

Fourteen additional cases are retained in [public-more.json](../src/test/examples/public-more.json), including exact source URLs and adaptations. They use built-in data and standard/recommended R packages, with no runtime downloads. The cases cover:

| Public manual | Exercise |
| --- | --- |
| [prcomp](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/prcomp.html) | Scaled USArrests PCA, orthonormal loadings, variance totals, scree plot and biplot |
| [aggregate](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/aggregate.html) | Airquality grouped quantiles, including matrix-valued Ozone/Temp columns; all five rows checked against expected values |
| [kmeans](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/kmeans.html) | Fitted centres, sum-of-squares identities and two cluster plots |
| [arima](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/arima.html) | Presidents series with missing observations, model comparison, residual diagnostics and forecasts |
| [nls](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/nls.html) | Puromycin Michaelis-Menten fit, convergence, coefficients and fitted curve |
| [HoltWinters](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/HoltWinters.html) | CO2 and AirPassengers seasonal fits, fitted matrix and three plot pages |
| [stl](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/stl.html) | Seasonal decomposition, exact component reconstruction and two plot pages |
| [rasterImage](https://stat.ethz.ch/R-manual/R-devel/library/graphics/html/rasterImage.html) | Two cases: the manual's interpolation/15-degree rotation example, and asymmetric colours with all four axis-reflection combinations |
| [layout](https://stat.ethz.ch/R-manual/R-devel/library/graphics/html/layout.html) | Five pages of layouts and marginal histograms, including empty bins |
| [filled.contour](https://stat.ethz.ch/R-manual/R-devel/library/graphics/html/filled.contour.html) | Volcano topography, colour key, axes and title |
| [grid.raster](https://stat.ethz.ch/R-manual/R-devel/library/grid/html/grid.raster.html) | Four pages with smooth, blocky, stretched and repeated rasters |
| [xyplot](https://stat.ethz.ch/R-manual/R-devel/library/lattice/html/xyplot.html) | Quakes in eight depth panels, followed by updated strips/aspect |
| [txtProgressBar](https://stat.ethz.ch/R-manual/R-devel/library/utils/html/txtProgressBar.html) | Console progress styles, Unicode and completion; tutorial sleeps removed |

This pass found and fixed five problems:

1. **Raster transforms and sampling.** Retained SVGs smoothed `interpolate=FALSE`, rotated around the image centre, and failed to reflect reversed axes. They now rotate about R's anchor, account for the downward device Y axis, reflect pixels, and request nearest-neighbour rendering when interpolation is disabled. JGD 0.2.0's public CRAN device source confirms that its raster fields directly retain R's signed device coordinates.
2. **Composite table columns.** Numeric matrix columns were incorrectly treated as scalar numeric fields. Sorting five grouped rows returned fifteen indices; filtering could select indices beyond the table. Matrix/array cells now retain their values as composite text cells with scalar sorting/filtering disabled. Ordinary scalar columns still sort and page the complete rows correctly. Regressions check both query paths and verify the original R object is unchanged.
3. **Imported graphics calls.** Functions imported by `stats` bypassed rebound `plot.new` functions. Standard graphics retained only the final plot when several time series were drawn in one expression; JGD could report unclosed execution groups at new pages. Native R page hooks now cover imported functions too. Regressions draw three named time series within one expression through both backends, with warnings promoted to errors.
4. **Previous plot duplicated by layout changes.** `filled.contour()` configures a layout before drawing. That could make the standard backend capture the preceding cell's plot again. Trailing `layout()` changes are now excluded from drawing comparisons, alongside `par()` changes. The contour regression verifies exactly one new page and no preceding title.
5. **Missing zero-count bar borders.** SVG omits rectangles with zero width or height. The public marginal-histogram example therefore lost the outlines of empty bars. Degenerate rectangles now render their border as a line, matching ordinary R.

The runner now saves every retained page and reads compressed local assets directly, so the dense contour SVG is not limited by the small-asset RPC. It saves artifacts before assertions for failure inspection and rejects internal JGD group warnings. Twelve final JGD plots were rasterized with the bundled Sharp renderer and visually compared with ordinary-R PNGs at 800 × 600. The corrected raster bounds, reflection, rotation, empty bars, panel geometry, labels and fitted curves match. Smooth-image resampling, font rendering, colour management and antialiasing vary between renderers; these comparisons do not assert pixel identity. The public `rasterImage` example itself emits R's expected matrix-recycling warning.

Final local validation on macOS/R 4.6.1 passed **434 extension tests** in VS Code 1.140.0, **47 arf runtime/library tests**, **37 standard-graphics runtime/library tests** (10 optional/JGD skips), and **489 sess checks**. All three example suites were rerun through R + JGD, arf + JGD, and R + standard graphics: **108 successful executions**, including 42 executions of the fourteen new cases. TypeScript, the production build and R lint passed; TypeScript lint retained its 70 existing warnings with no errors. DT was installed only in the temporary test library for the earlier widget examples. Existing user libraries and sessions were not modified.
