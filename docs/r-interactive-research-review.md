# Research workflow review — 2026-10-01

This pass reviewed PR #1805 against the user guide, contributed commands/settings, existing regression suites, and the prior native-testing reports. The test host was macOS arm64, latest stable VS Code **1.140.0**, R 4.6.1, arf 0.5.1, data.table 1.18.6.1, and JGD 0.2.0. All new work used disposable profiles, libraries, files, and sessions. Existing user sessions were not used or stopped.

## Findings and changes

| Research task | Observed problem | Fix and verification |
| --- | --- | --- |
| Inspect data before resampling or splitting a dataset | Registering a viewer used `sample.int()` for its ID. `set.seed(2026); head(iris)` changed subsequent random draws, and even initialized `.Random.seed` when absent. | IDs use a session-local counter and PID. Package tests cover uniqueness and both seed states; real R/arf tests compare seeded bootstrap results across cells containing automatic display, `View()`, and `sess::display()`. Native input reproduced the failure and then passed with the corrected runtime. |
| Compare data before and after cleaning | An old data.table preview showed original values, but fetching its next page after `:=` returned the modified values. Renaming and sorting could also alter the historical result. | Copy data.table before registering an Interactive snapshot. Tests verify old pages, filtering and sorting after value/schema/order changes, while the live user object keeps the changes. Native arf showed rows 21–40 unchanged, sorted down from 50, and filtered to original value 49 after the live values had been multiplied by 100. |
| Run several data.table transformations | `withVisible()` alone treated reference assignments as visible, producing unwanted tables for `:=`. | Honor data.table's exported `shouldPrint()` autoprint flag. Tests cover quiet `:=` and `set()`, ordinary display, chained `[]`, explicit `View()` / `sess::display()`, and console `print()`. A native cleaning/model-fitting cell produced one requested table. |
| Control noisy model diagnostics | `options(warn = -1)` still emitted warnings into the cell. | Honor warning suppression while preserving ordinary warnings and warnings-as-errors. Real-process tests cover `warn = -1, 0, 1, 2` and `suppressWarnings()`. |
| Inspect missingness and schema | Inline headers omitted available R type metadata; actual missing values looked like the string `"NA"`; legacy nested JSON appeared as `[object Object]`. | Add header type tooltips, accessible muted/italic `NA` and `NaN` labels, and JSON formatting for nested values. Literal strings and infinity remain distinct. Native verification covered numeric/character/Date columns; browser regressions cover these distinctions and existing numeric formatting. |
| Use model diagnostics without JGD | Six diagnostics in a 2×2 layout produced eight fallback snapshots, including partial and repeated pictures, rather than two pages. Checking only output types missed this. | Stable per-page display IDs replace incremental snapshots. Capture page boundaries rather than each base-graphics panel, ignore trailing layout-only changes, and restrict capture to the managed device. Regressions cover `mfrow`, `mfcol`, `layout()`, incremental titles, grid pages and explicit PDF devices. The research runner now checks the diagnostic page count. |

## End-to-end analysis matrix

The reproducible [research fixtures](../src/test/examples/research.json) use built-in datasets and assert results inside R, expected display kinds, selected printed summaries, and the number of diagnostic pages. All twelve cases passed for **plain R + JGD**, **arf + JGD**, and **plain R + standard graphics**: **36 workflow runs**.

| Workflow | Checks |
| --- | --- |
| CSV import and cleaning | UTF-8 labels, duplicate removal, missingness counts, dates, grouped summaries |
| data.table manipulation | Grouping, joins, melt/dcast, row counts, nonmissing results, Unicode labels |
| Tidy analysis | dplyr/tidyr grouped means, standard errors, pivoting, observation counts |
| Summary statistics and inference | Quantiles, contingency/proportion tables, t-test, chi-square output and confidence intervals |
| Linear models | Coefficients, summary output, ANOVA, coefficient intervals and prediction intervals |
| Logistic models | Convergence, probabilities, Wald odds ratios, confusion table and classification accuracy |
| Bootstrap analysis | Identical seeded results with intervening rich data inspection; interval table and histogram |
| Model diagnostics | Six `plot.lm` diagnostics across two 2×2 plot pages, titles/axes preserved |
| Grouped visualization | Faceted ggplot scatterplots, linear fits, 95% confidence ribbons and legend |
| Survival analysis | Cox model summary, hazard ratios, Kaplan-Meier curves and legend |
| Data/model output | CSV and gzip round trips with quotes/newlines/Unicode, RDS model/metadata, PDF and SVG file output |
| Larger data | Preview and grouped aggregation over 100,000 rows without serializing the whole table into the cell |

Four retained JGD plots were visually compared with independent ordinary-R PNG references: bootstrap histogram, the last diagnostic page, faceted regression, and survival curves. Shapes, intervals, axes, labels, legends, and page layout matched; this is visual validation, not pixel equality. The first diagnostic page was also inspected in the native window. The reference runner evaluates its bookkeeping in a local environment so it cannot overwrite an analyst's global `result` object.

A new native **Research standard** session (PID **88512**) verified the fallback correction: six diagnostics produced exactly two pages, with four complete panels on the first page, working Previous/Next controls and no live-device resize action. The fallback's final page was also visually inspected from its saved SVG. **Stop All** listed only the three disposable research sessions, stopped all three, retained their output and stopped notices, and cleared the active Workspace.

The recorded workflow timings include a fixed 350 ms settle delay and polling. They are not isolated R execution times or remote-latency benchmarks. The runner saves code, events, outputs, references, and a machine-readable result file; see [runner instructions](../src/test/examples/README.md).

## PR capability coverage

| Capability | Evidence in this pass and existing suites |
| --- | --- |
| Startup, optional dependencies, supervision | Full suite covers executable discovery, no arf, no Node on PATH, no tmux fallback, explicit-supervisor errors, private runtime installation and preflight preserving live R. Real detached and tmux process tests run. |
| Persistence and multi-session ownership | Native R and arf retained PIDs **44668** and **63205** across reload, including independent `lm`/`glm` objects, data, and random results. Workspace followed each session and displayed the matching model class and unique objects. Both session tooltips reported connected/controlling. Automated tests also cover editor termination, deduplication, leases, reconnect and two-session restoration. |
| Execution and lifecycle | Full suite covers streaming, queued-cell ordering/cancellation, prompts, debugger continuation, interrupt, process death, stop, bulk stop and restart in the same notebook. Native research R was restarted with its prior transcript/boundary retained, then survived subsequent reloads. |
| Language services and source execution | Full suite exercises virtual-input diagnostics, blank prompts, hover/signatures and owning-session bindings, source-target choice, terminal routing, code reuse and draft preservation. Prior native checks are documented in the live-testing report. |
| Tables and models | New research tests plus numeric/precision, integer64, date, filtering/paging and print-snapshot regressions. Native retained-table paging, descending sort, exact-value filter, type/missingness display and separate model environments verified. |
| Plots, HTML and exports | Full suite covers pagination, resizing, multi-device attribution, save readiness, standard fallback, widgets/MIME, offline state and all four history formats. Public examples were rerun with both R and arf. Prior browser/native runs cover DT/Plotly interaction, Shiny controls, actual SVG/PNG saves and portable HTML widgets. |
| Storage and resource recovery | Full suite covers lossless compression, live quota changes, once-per-cell quota reporting, safe cleanup, corrupt journals, export and protected assets across generations. These disk-storage tests do not bound R heap usage. |
| Ordinary R and renv | Both-provider library tests cover startup library order, default package-install destination, project dependency precedence, private bridge isolation, snapshot and offline restore with local fixture packages. |

## Validation results

| Check | Result |
| --- | --- |
| Full extension suite, latest stable VS Code 1.140.0, real tmux enabled | **411 passed** |
| arf runtime/library suite, including adoption and renv | **38 passed** |
| Standard-graphics runtime/library suite | **29 passed**, 9 JGD/optional checks skipped |
| Full freshly installed private sess package | **442 checks passed** |
| Browser renderer: dark, narrow light, high contrast | **74 assertions passed per layout** |
| Research workflows: R/JGD, arf/JGD, standard graphics | **36 passed** |
| Public examples rerun: R/JGD, arf/JGD and standard graphics | **30 passed** |
| TypeScript checking, bundled assets and lint | Passed; **0 lint errors, 70 existing TypeScript warnings** |

The earlier [public-example report](r-interactive-public-examples.md) records the public standard-graphics run and widget interactions. The [live-testing report](r-interactive-live-testing.md) records the preceding native pass for all session controls, prompts, exports, language features and application quit/reopen. Earlier counts there describe those earlier revisions.

## Practical limits

- Historical live table data remains in R memory for the life of the process. Correct data.table snapshots require copies; repeated full-dataset displays can therefore consume substantial memory. Use `head()`, summaries, or explicit `print()` for large repeated inspections. Closing an expanded viewer must not invalidate a table still referenced by the transcript. Automatic table-memory eviction is not implemented.
- This host has no XQuartz/Cairo SVG support; ordinary `grDevices::svg()` also fails here. The file-output fixture uses `svglite::svglite()` and verifies the written SVG/PDF. Explicit file devices intentionally do not add an inline plot.
- Actual Remote SSH transport, remote latency, logout policy and systemd user services were not exercised on a remote server. Linux CI and local process tests cover the launcher logic, not a particular server configuration.
- These workflows are representative coverage, not a claim that every R package, native graphics device, custom class printer or reference-backed object is supported. Custom user printers can still have their own side effects. Persistent sessions do not survive R termination or host reboot.
- Existing sessions keep their original R bridge. Start a new session for the fixes, or save needed objects before restarting. Merely reloading VS Code updates the renderer but cannot replace code in an already-running R process.
