# Interactive live testing — 2026-10-01

This pass used a disposable VS Code profile, workspace, registry, R libraries, and sessions on macOS arm64. The user's existing R/arf sessions were not used or stopped. The expanded native UI pass ran on VS Code **1.139.1**, R 4.6.1, Node 26.10.0, arf 0.5.1, and JGD 0.2.0. The cached app had automatically updated; the minimum-version cache was replaced with a fresh official 1.110.0 build before running the automated matrix. Both test versions were verified from their application manifests.

## Findings fixed

| Finding from live use | Change and verification |
| --- | --- |
| Real HTML widgets displayed a blank/error frame inside desktop VS Code | The asset server's CSP wildcard excluded the editor's custom schemes. Allowing `vscode-webview:` and `vscode-file:` as frame ancestors fixes native embedding while retaining the iframe sandbox and other restrictions. A real htmlwidget with a retained local JavaScript dependency now updates its chart inline and in the expanded viewer. HTTP policy and invalid-token regression tests were added. |
| Namespace calls produced `Failed to run diagnostics` on nonexistent `/Interactive-1.interactive` files | Unsaved notebook cells use a pathless URI when talking to languageserver. Results map back to the original cell URI. Two-cell regressions check namespaced calls, diagnostic locations, and clearing a diagnostic after an edit. Native Problems no longer shows the failure; ordinary lint suggestions remain. |
| macOS exported `.html`, `.R`, and `.ipynb` names as `.rnb` files | History export now asks for a format before opening a save dialog with a single filter. The selected format determines serialization. All four native exports were saved and inspected; the HTML report's exported widget was exercised in a browser. Cancellation and filter/default-name regressions were added. |
| Export dialogs had no useful default name, and enlarged outputs looked like additional session tabs | Plot/history exports suggest the session name in its working directory, with execution order in plot names. Expanded tabs use `Plot:` or `Viewer:`. Native save dialogs and tab titles were checked. |
| A simple R error filled the window with worker and arf transport calls | Traces now start inside the evaluated expression and end before condition-handler plumbing. Real plain-R and arf regressions retain nested user calls, warnings/messages, parse errors, and user functions named `eval`. This final improvement was verified by runtime tests; the Mac locked before a final native rendering check. |

## Native UI coverage

| Area | Checks completed |
| --- | --- |
| Creation and routing | Fresh-window Cmd+Enter target chooser; create plain R; execute captured code once; create arf; independent environments; switch through tabs and the status bar; source-document binding to arf while plain R was last active. The bound source printed arf's PID 96790. |
| Kernel and session controls | Starting/idle/busy transitions; compact kernel fields; session tooltip; rename; Session Details command; observer status with a second client; Take Control. |
| Execution | Streamed output; warnings/messages/errors and recovery; sequential queue; cancel queued work; interrupt a running sleep; verify neither cancelled nor interrupted assignments ran. |
| Input | Cancel/reopen a `readline()` request, reply, and resume; `browser()` continuation with `c`. |
| Language features | Namespaced-call diagnostics and correction; session-object completion; hover displaying the live value `num 202`. |
| Tables | Numeric labels and full-value tooltips; contiguous pages 1–20, 21–40, and 41–53 with disabled boundaries; expanded viewer sorting/filtering; clear filters; size to content, fit width, and reset. |
| Plots | User's complete faceted diamonds plot; no quota-message storm; SVG/PNG save picker; Fit R device; enlarged view; Browse Plots; safe asset cleanup. Saved diamonds SVG and PNG both have 800 × 600 dimensions; PNG is 165,950 bytes. |
| HTML and MIME | Real htmlwidget/local JavaScript interaction inline and in the viewer; explicit Markdown, HTML, and plain-text displays. |
| History and reuse | Search; insert while preserving a draft; Copy; Run again; all four export formats. Reopened `.rnb` renders a static plot and explains disabled/offline controls. Jupyter export parses as nbformat 4 with standard SVG/text output. Exported HTML widget interaction works independently of R. |
| Clear and detach | Clear Completed preserves the input draft. Detach/open restores retained history and the draft in the same tab. |
| Restart | Cancel confirmation; confirm target name; keep the same tab, draft, and old output; show restart boundary; new R PID; old objects absent; new assignments work; old plots remain viewable. |
| Stop | Cancel confirmation; confirm stop; stopped notice appears and history remains. Sending from a source document bound to the stopped session opens the replacement-target chooser. |
| Persistence | Real Developer: Reload Window and normal application quit/reopen restore both tabs without duplicates. Plain R kept PID 83671, value 42, the input reply `reader`, and a 53-row table. Restarted arf kept PID 96790 and value 202 across app exit. Both inputs successfully checked those values after reopening. |

## Automated matrix

| Check | Result |
| --- | --- |
| Full extension suite, VS Code 1.110.0, tmux enabled | 347 passed |
| Final Interactive-only verification on 1.110.0 after trace/lint adjustments | 84 passed |
| Full extension suite, VS Code 1.119.0, tmux enabled | 347 passed |
| arf runtime matrix, including existing arf adoption | 24 passed |
| Standard-graphics runtime matrix | 19 passed; 5 JGD-only cases skipped |
| Fresh private sess package, full tinytest suite | 430 checks passed |
| Browser renderer, dark / narrow light / high contrast | 46 assertions passed in each layout |
| TypeScript and production bundles | Passed |
| TypeScript lint | 0 errors; 70 existing warnings |
| R source/package lint, failures treated as errors | Passed |

The full suites exercise lifecycle output ordering, reload restoration, restart generations, stale manifests, source targeting, language-server diagnostics, compressed assets and quotas, table paging, history/export, detached launch, real tmux supervision, and runtime inspection. The renderer harness covers disabled controls, numeric precision, stale replies, image readiness, format selection, layout stability, and disposal. See [the implementation review](r-interactive-review.md) for the earlier feature-by-feature regressions and Positron comparison.

## Limits and remaining checks

- Actual Remote SSH, Linux behavior, network interruptions, and `systemd --user` policies still need verification on the user's server. Local tmux/process tests do not establish remote transport behavior or latency.
- The Mac locked near the end of the native pass. The legacy terminal was created through the replacement-target chooser, but its final console output was not visually verified. A live URL/Shiny viewer and the final shortened-error rendering were not checked natively in this pass. Terminal routing and error traces are covered by automated tests.
- Native VS Code accessibility announcements decode the selected custom MIME payload as text, exposing JSON fields to screen readers. The public renderer/controller API has no separate announcement-text field. A plain-text MIME fallback does not change the selected-MIME announcement; this remains an upstream limitation.
- Renaming a session updates its kernel/status/picker presentation, but an already-open native Interactive tab can retain its original name. Widget frames currently use a fixed height, which can leave whitespace for small widgets.
- Existing agents retain their original HTTP policy and R runtime. Reloading updates editor-side diagnostics and export behavior; start a new session or explicitly restart a managed session to use the widget policy and shortened error traces. Restart loses in-memory R objects, so a new session is preferable while old work is still needed.
