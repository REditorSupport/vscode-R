# Large-table responsiveness review

The reported object was a data.table with **832,976,871 rows and 23 columns**. Evaluating it took about 55 seconds although the cell displayed only 20 rows. The Interactive bridge deep-copied the complete table before registering its historical view, then invoked the class printer on the complete object. Limiting retained print bytes did not limit the work needed to produce them.

## Changes and copy audit

| Path | Behavior after this change |
| --- | --- |
| Interactive snapshot | Subset at most 1,000 rows and 100,000 cells before printing or registration, with at least one row for extremely wide tables. data.table row subsetting already creates independent columns; no extra `copy()` call duplicates the whole table, factor levels, or nested objects. |
| Original dataset | A separate handle retains the full object without copying it. Inline navigation beyond the snapshot, or sorting/filtering, retrieves pages through that handle. The expanded viewer remains available. Both handles survive reconnection while the same R process lives. |
| Full-data pages | Subset only requested rows. Unfiltered/unsorted pages have no whole-table index. Metadata comes from a zero-row schema. |
| Reference edits | Inline saved rows stay stable. Full-view filter/sort caches expire after Interactive execution, including errors, and ordinary task callbacks for attached terminal edits. Reopening refreshes metadata. Requests against a changed schema fail with a reopen instruction instead of mislabelling values. |
| Matrix data | Select requested matrix rows before extracting columns. Trim row names only for the requested page, rather than duplicating the full row-name vector at registration. |
| Sort and filter | Reuse original column vectors for the first operation instead of copying through an identity row index. Sorting/filtering still performs full-data work when requested, and stores query indices for subsequent pages. |
| Nested list cells and strings | Bound recursive preview traversal; summarize large nested data by class/dimensions before copying, printing or JSON encoding. Shorten long text with an explicit marker. Full-view filtering still sees the complete original string. |
| Workspace refresh | Read dimensions, classes, lengths and column metadata without computing object size or serializing data. Bound automatic names metadata to the first 1,000 names of enormous named lists; child paging remains available for later entries. |
| Extension/renderer/export | Serialize only bounded rows and captured text. Inline paging automatically moves from the snapshot to the full handle when needed, retaining only the current fetched page. Reset returns to the immutable preview. Persist/export the original preview and row count, without accumulating browsed pages. |

This bounds the extension's ordinary viewing path, not arbitrary user code. Custom subset/print methods can still perform their own expensive operations. R's copy-on-modify behavior still applies to subsequent user edits of shared ordinary data frames. Full-data handles retain the original object, including after a variable is rebound or removed; distinct historical objects can still consume memory. No automatic R-heap eviction is introduced.

## Reproducible measurements

Run `R_LIBS=/path/to/test-library Rscript src/test/examples/large-table.R` after installing this checkout's sess into that library. The script includes row subsetting, registration, page formatting, class printing, and JSON encoding in the complete-preview measurement. It also asserts that no single preview allocation reaches 8 MiB. Timings are local R-side measurements on macOS arm64, R 4.6.1/data.table 1.18.6.1; they are not a measurement on the user's remote server.

| Case | Elapsed | Total allocation | Largest allocation |
| --- | ---: | ---: | ---: |
| Old copy alone, 100,000 × 23 numeric data.table | 2 ms | 17.565 MiB | 0.763 MiB |
| New complete preview, 100,000 × 23 (first data.table run) | 29 ms | 3.560 MiB | 0.562 MiB |
| Old copy alone, 2,000,000 × 23 numeric data.table | 32 ms | 350.970 MiB | 15.259 MiB |
| New complete preview, 2,000,000 × 23 (warm) | 7 ms | 0.629 MiB | 0.250 MiB |
| Full-data final page, 2,000,000 × 23 | 2 ms | 0.029 MiB | 0.008 MiB |
| New complete preview, 832,976,871 × 23 ALTREP data.frame | 52 ms | 1.258 MiB | 0.250 MiB |
| Full-data final page, 832,976,871 × 23 ALTREP data.frame | 1 ms | 0.005 MiB | <0.001 MiB |

The exact-dimension test uses compact integer sequences; it does not allocate a dense 833-million-row data.table. The separate dense data.table measurements verify its actual subset/copy behavior. At 2 million rows the complete new preview allocates over 99% less than the old copy alone, and allocation stays bounded as the row count increases.

## Original snapshot validation

- Full native extension suite on latest stable VS Code **1.140.0**: **414 passing**, including snapshot scope in native cells/HTML export and opening the full viewer.
- Real arf runtime/library suite: **40 passing**. New regressions cover exact large dimensions, first/last pages, reconnect, immutable inline rows, failed execution after a reference edit, stale-query invalidation and renamed columns.
- sess package: **478 checks passing**, covering wide/empty tables, long text, deep nested cells, nested data.table edits, factor-level sharing, matrix row names, and workspace child paging.
- Browser renderer: **79 assertions per layout**, dark, narrow light, high contrast. Snapshot labels, boundary controls, Text switching and offline behavior are checked.
- All twelve R + JGD research workflows were rerun successfully.
- The reproducible allocation benchmark above passes; R lint reports no issues. TypeScript/build checks pass with the existing 70 TypeScript lint warnings.

Existing persistent sessions keep the R bridge loaded when they started. Start a new session for the new viewing path, or preserve needed R objects before restarting a managed session. Reloading VS Code alone does not replace a running session's bridge.

## Inline browsing follow-up

The lightweight inline viewer now offers first/last navigation, arbitrary page jumps, 20/50/100-row pages, column sorting, explicit typed filters, drag-to-reorder columns and Reset. The 1,000-row snapshot remains a fast, stable saved preview rather than a navigation limit. The [user guide](r-interactive.md) explains saved/live semantics, cache lifetime and stopped-session controls.

The extension validates queries against the owning output's handles and limits each request to at most 100 rows. No new R bridge or dataset copy is introduced. The renderer keeps one current page per cached output, with a 32-output cache limit; it never builds a cache of all visited pages. Sorting/filtering reuse the existing R query-index cache, while ordinary navigation needs no full-data index. Large explicit sorts/filters still have their normal R memory and execution costs.

Live regressions exercise the final 11 rows of the exact-dimension compact fixture through the inline query helper and the actual notebook message handler. A separate 2,000-row data.table test combines descending sorting with text/date/logical filters, widens pages, visits the last filtered page, renames a column and restores the unchanged snapshot. Testing found that snapshot row names can become character labels while live row numbers remain numeric; schema comparison now excludes that synthetic, non-sortable index so valid filters are not silently cleared.

Follow-up validation on VS Code **1.140.0**: **424** native extension tests passed, **41** arf runtime/library tests passed, and **105** browser assertions passed in each of dark, narrow light, and high-contrast layouts. Browser coverage includes snapshot transitions, direct/last-page requests, page sizes, sort cycling, explicit filtering, empty results, draft retention, drag/keyboard reordering, Reset after stop, stale replies, and output replacement. Build/type checks and lint pass with the existing 70 TypeScript warnings. The allocation benchmark above was rerun successfully, including its bounded-preview allocation assertions. The original snapshot validation numbers above describe the preceding revision.

This follow-up is editor-side: sessions already created with bounded snapshots and full-data handles can keep running after the extension update/reload. Only older agents lacking those handles need a new session to expand a truncated snapshot.

The subsequent toolbar simplification removes the Columns button and its panel, keeping header dragging and Reset. Build/type checks, targeted lint and **102 browser assertions per layout** (dark, narrow light, high contrast) pass; the three removed assertions exercised the deleted panel.
