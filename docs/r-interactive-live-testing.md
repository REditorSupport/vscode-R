# Interactive live testing — 2026-10-01

This pass used a disposable VS Code profile, workspace, registry, R libraries, and sessions on macOS arm64. The user's existing R/arf sessions were not used or stopped. The expanded native UI pass ran on VS Code **1.139.1**, R 4.6.1, Node 26.10.0, arf 0.5.1, and JGD 0.2.0. The cached app had automatically updated; the minimum-version cache was replaced with a fresh official 1.110.0 build before running the automated matrix. Both test versions were verified from their application manifests.

A follow-up native pass on **1.119.0**, with updates disabled in its private profile, completed the terminal, Shiny, and error-rendering checks. It also exercised the native cell toolbar directly, exposing the two additional fixes below. Reload kept the plain R session's PID 43381 and objects throughout the pass.

At the user's request, testing then moved to the latest stable release, **1.140.0**. The official update service and the downloaded application's `product.json` both identify commit `07f806f999227108933c2e30515b26eecc1fda74`. The latest-release native checks used a fresh private profile and registry. Older versions below are compatibility results, not the primary test target.

On 1.140.0, native checks covered first-run source routing, independent plain R and arf sessions, numeric previews and all three table pages, expanded sorting, the faceted diamonds plot, SVG/PNG saves, device fitting, the enlarged plot, Shiny reactivity and interrupt recovery, readable nested errors, cell action visibility, lifecycle-notice guards, new-session focus, and restart. Both image files were verified as 800 × 600. Shiny's slider changed from 10 to 25 and updated its plot. Plain R retained PID 66001, value 42, and its 53-row table across reload and full app quit/reopen; arf retained PID 68760 and value 202. The restart check kept one tab and old output, changed PID 72752 to 73344, and confirmed the old R object was absent. The corrected New Session command focused PID 72752 without duplicating the tab or replacing the arf input draft. Disposable sessions were stopped after verification.

## Findings fixed

| Finding from live use | Change and verification |
| --- | --- |
| Real HTML widgets displayed a blank/error frame inside desktop VS Code | The asset server's CSP wildcard excluded the editor's custom schemes. Allowing `vscode-webview:` and `vscode-file:` as frame ancestors fixes native embedding while retaining the iframe sandbox and other restrictions. A real htmlwidget with a retained local JavaScript dependency now updates its chart inline and in the expanded viewer. HTTP policy and invalid-token regression tests were added. |
| Namespace calls produced `Failed to run diagnostics` on nonexistent `/Interactive-1.interactive` files | Unsaved notebook cells use a pathless URI when talking to languageserver. Results map back to the original cell URI. Two-cell regressions check namespaced calls, diagnostic locations, and clearing a diagnostic after an edit. Native Problems no longer shows the failure; ordinary lint suggestions remain. |
| macOS exported `.html`, `.R`, and `.ipynb` names as `.rnb` files | History export now asks for a format before opening a save dialog with a single filter. The selected format determines serialization. All four native exports were saved and inspected; the HTML report's exported widget was exercised in a browser. Cancellation and filter/default-name regressions were added. |
| Export dialogs had no useful default name, and enlarged outputs looked like additional session tabs | Plot/history exports suggest the session name in its working directory, with execution order in plot names. Expanded tabs use `Plot:` or `Viewer:`. Native save dialogs and tab titles were checked. |
| A simple R error filled the window with worker and arf transport calls | Traces now start inside the evaluated expression and end before condition-handler plumbing. Real plain-R and arf regressions retain nested user calls, warnings/messages, parse errors, and user functions named `eval`. Native follow-up verified concise nested traces. |
| Native cells showed the user calls but omitted the actual error message | VS Code renders a nonempty stack in place of the separate message. The stack now includes the error heading and message before the user calls. Native `sqrt("bad")` through nested functions shows the cause clearly; an editor regression checks the native error MIME and R/Jupyter exports. |
| Insert, Copy, and Go to Source were missing from native cell toolbars | Native Interactive toolbars do not supply the `notebookCellType` context used by the visibility rule. The actions now use the R notebook/kernel context and appear as icons with tooltips. Native clicks verified draft-preserving insertion, exact code copy, source navigation, and an explanation for directly entered code. Lifecycle notices are guarded against insertion as R code. |
| Creating a second session left keyboard focus in the previous session's input | The explicit **New Persistent Interactive Session** command now focuses its new input. Source-editor routing retains its existing focus behavior. An editor regression keeps an old draft and executes from the new input, checking that the code reaches only the new session. |
| Workspace could show a different session from the focused bound source, and actions could follow a later execution target | Focus now selects the bound session. Tree nodes and dialog actions capture their session owner. Late child replies are discarded after switching, background updates do not activate their sender, and Refresh requests a fresh snapshot. The header identifies the session and PID. |
| Workspace retained old objects after detach and could leave actions disabled after startup | Detach clears the active workspace; stop, restart, and disconnect show an explicit state. Readiness updates refresh command availability and attached-session metadata without requiring another focus event. |
| Cell reuse opened a native Interactive document through the generic notebook API | Reuse now calls the native Interactive opener and keeps the existing tab layout. The editor regression checks the layout as well as the preserved draft and execution count. |

## Workspace switching follow-up

The follow-up used VS Code **1.140.0** with a fresh private profile and registry. Plain R **Workspace A** used PID 30771 and arf **Workspace B** used PID 31493. Both contained `workspace_list` and `workspace_table` with different contents, plus `only_A` or `only_B`.

Native tab clicks changed the Workspace header, PID, and unique objects together. Expanding A's list showed `owner: "A"`; focusing a source bound to A restored A after selecting B. The table's View action executed in A. Reload retained both processes and selected the workspace matching the focused tab, including A when B was restored later. Save/Clear/Refresh were enabled for the ready session.

A second VS Code development window observed B while the first continued to display A. Switching between the actual application windows preserved those independent selections. Restarting A displayed the restarting message, changed its PID to 36771, removed its previous objects from Workspace, and retained the Interactive transcript. Stopping it displayed **R session stopped** with an empty environment. The private test sessions and windows were closed after verification.

The final full suite passed **354 tests**, including local tmux coverage. Workspace regressions cover late replies, node ownership, non-syntactic object names, dialog focus changes, readiness, and detach cleanup. Native test automation now waits for the exact input/source document, passes the target URI to the native Execute command, and uses a dedicated source-editor group for restart checks; relying on implicit editor focus caused failures in the full run. TypeScript and production builds pass; lint reports zero errors and 70 existing warnings.

## Native UI coverage

| Area | Checks completed |
| --- | --- |
| Creation and routing | Fresh-window Cmd+Enter target chooser; create plain R; execute captured code once; create arf; independent environments; switch through tabs and the status bar; source-document binding to arf while plain R was last active. The bound source printed arf's PID 96790. Follow-up created a legacy R terminal through the chooser and visually verified `Legacy terminal verified: 42` in its Accessible View; the selected source text remained intact. |
| Kernel and session controls | Starting/idle/busy transitions; compact kernel fields; session tooltip; rename; Session Details command; observer status with a second client; Take Control. |
| Execution | Streamed output; warnings/messages/errors and recovery; sequential queue; cancel queued work; interrupt a running sleep; verify neither cancelled nor interrupted assignments ran. |
| Input | Cancel/reopen a `readline()` request, reply, and resume; `browser()` continuation with `c`. |
| Language features | Namespaced-call diagnostics and correction; session-object completion; hover displaying the live value `num 202`. |
| Tables | Numeric labels and full-value tooltips; contiguous pages 1–20, 21–40, and 41–53 with disabled boundaries; expanded viewer sorting/filtering; clear filters; size to content, fit width, and reset. |
| Plots | User's complete faceted diamonds plot; no quota-message storm; SVG/PNG save picker; Fit R device; enlarged view; Browse Plots; safe asset cleanup. Saved diamonds SVG and PNG both have 800 × 600 dimensions; PNG is 165,950 bytes. |
| HTML and MIME | Real htmlwidget/local JavaScript interaction inline and in the viewer; explicit Markdown, HTML, and plain-text displays. A real Shiny app opened through **Open application**; moving its slider from 10 to 22 updated the count and plot. Interrupt returned R to idle and a subsequent cell printed `Execution after Shiny interrupt verified: 42`. Shiny's own interruption backtrace remains ordinary streamed output. |
| History and reuse | Search; insert while preserving a draft; Copy; Run again; all four export formats. Native cell icons separately verified Insert, Copy, and Go to Source. Reopened `.rnb` renders a static plot and explains disabled/offline controls. Jupyter export parses as nbformat 4 with standard SVG/text output. Exported HTML widget interaction works independently of R. |
| Clear and detach | Clear Completed preserves the input draft. Detach/open restores retained history and the draft in the same tab. |
| Restart | Cancel confirmation; confirm target name; keep the same tab, draft, and old output; show restart boundary; new R PID; old objects absent; new assignments work; old plots remain viewable. |
| Stop | Cancel confirmation; confirm stop; stopped notice appears and history remains. Sending from a source document bound to the stopped session opens the replacement-target chooser. |
| Persistence | Real Developer: Reload Window and normal application quit/reopen restore both tabs without duplicates. Plain R kept PID 83671, value 42, the input reply `reader`, and a 53-row table. Restarted arf kept PID 96790 and value 202 across app exit. Both inputs successfully checked those values after reopening. |

## Automated matrix

| Check | Result |
| --- | --- |
| Final full extension suite, latest stable VS Code 1.140.0, tmux enabled | 354 passed |
| Earlier full extension suite, VS Code 1.110.0, tmux enabled | 347 passed |
| Earlier Interactive-only verification on 1.110.0 after trace/lint adjustments | 84 passed |
| Full extension suite, VS Code 1.119.0, tmux enabled | 348 passed before the final new-session focus adjustment |
| arf runtime matrix, including existing arf adoption | 24 passed |
| Standard-graphics runtime matrix | 19 passed; 5 JGD-only cases skipped |
| Fresh private sess package, full tinytest suite | 430 checks passed |
| Browser renderer, dark / narrow light / high contrast | 46 assertions passed in each layout |
| TypeScript and production bundles | Passed |
| TypeScript lint | 0 errors; 70 existing warnings |
| R source/package lint, failures treated as errors | Passed |

The full suites exercise lifecycle output ordering, reload restoration, restart generations, stale manifests, source targeting, language-server diagnostics, compressed assets and quotas, table paging, history/export, detached launch, real tmux supervision, and runtime inspection. The renderer harness covers disabled controls, numeric precision, stale replies, image readiness, format selection, layout stability, and disposal. See [the implementation review](r-interactive-review.md) for the earlier feature-by-feature regressions and Positron comparison.

For future latest-release runs, use `npm run pretest` followed by `npx vscode-test --code-version stable`. Enable `VSCR_TEST_TMUX=1` when tmux is installed. Pin an older version only for a separate compatibility check, and verify the actual application version because cached desktop apps can update themselves.

## Limits and remaining checks

- Actual Remote SSH, Linux behavior, network interruptions, and `systemd --user` policies still need verification on the user's server. Local tmux/process tests do not establish remote transport behavior or latency.
- Native VS Code accessibility announcements decode the selected custom MIME payload as text, exposing JSON fields to screen readers. The public renderer/controller API has no separate announcement-text field. A plain-text MIME fallback does not change the selected-MIME announcement; this remains an upstream limitation.
- Unsubmitted native input drafts were preserved when creating another session, but were not restored after full application exit in the 1.140.0 pass. Persistent R objects and executed history survived. Save unfinished code in a source file before quitting.
- Renaming a session updates its kernel/status/picker presentation, but an already-open native Interactive tab can retain its original name. Widget frames currently use a fixed height, which can leave whitespace for small widgets.
- Existing agents retain their original HTTP policy and R runtime. Reloading updates editor-side diagnostics and export behavior; start a new session or explicitly restart a managed session to use the widget policy and shortened error traces. Restart loses in-memory R objects, so a new session is preferable while old work is still needed.
