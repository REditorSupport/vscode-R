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
