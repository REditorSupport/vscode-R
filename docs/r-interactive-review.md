# R Interactive review and Positron comparison

Reviewed against Positron's public documentation on 2026-09-30. This comparison concerns workflows, not performance measurements or complete IDE parity.

| Positron workflow | Value for this Interactive window | Implementation |
| --- | --- | --- |
| [Session picker, status, rename, and controls](https://positron.posit.co/managing-interpreters.html) | Make the execution destination clear when several R sessions run concurrently | Status bar with activity, queue count, disconnection and observer state; session-specific tree actions; persistent rename; session details |
| [Console history and code reuse](https://positron.posit.co/managing-interpreters.html) | Recover exploratory work without repeatedly scrolling through rich output | Search the durable admission ledger with bounded responses and older-result paging; insert without execution, preserve drafts, copy, explicitly rerun, and navigate to source |
| [Plot history and source navigation](https://positron.posit.co/plots-pane.html) | Find an earlier visualization and the code that produced it | Searchable plot picker over the restored transcript, enlarged plot view, cell source/reuse actions, existing SVG/PNG export |
| [Inline notebook data exploration](https://positron.posit.co/positron-notebook-editor.html) and [Data Explorer](https://positron.posit.co/data-explorer.html) | Inspect a result immediately and move to detailed analysis when needed | Reliable inline paging and exact row counts; use the existing expanded data viewer for sorting/filtering and typed columns |
| [Variables pane](https://positron.posit.co/variables-pane.html) | Inspect objects without diverting code to another session | Existing session-bound workspace and data viewers remain the primary object-inspection surface |

The most useful additions are destination/status visibility, code reuse, and reliable output navigation. These directly support long-lived tmux/arf work. Positron's notebook documentation describes closing a notebook as shutting down its interpreter; R Interactive intentionally keeps the R process alive when its view closes. Explicit source-document bindings also remain available here.

This iteration does not reproduce Positron's entire Data Explorer, column-summary panel, AI tooling, or application publishing. The expanded vscode-R data viewer already covers common sorting/filtering work. Plot browsing covers retained/restored outputs; it does not load evicted journal assets or reconstruct an R heap.

## Bugs and rough edges addressed

- The first inline table preview had 20 rows, but Next requested row 101, skipping 80 rows. Pagination now advances by 20, reports exact final-page bounds, prevents overlapping clicks, ignores stale replies, and retains the previous page when R is busy.
- Queued cells stayed pending after the R process died. The agent now records them as cancelled and notifies connected views.
- Busy arf sessions could defer termination, and late exit callbacks could write to a closed journal. Stop now interrupts evaluation, cancels queued work, and bounds termination; callbacks stop touching storage after the agent closes.
- Clearing the window deleted running cells and drafts, allowing later events to recreate cells unpredictably. Clearing now hides completed cells and retains the active work and durable history.
- Session operations could target the last active session instead of a clicked session or notebook. Commands now resolve explicit targets, with a multi-session regression test.
- Late output replaced whole cell documents, disrupting diagnostics, edits, and selection. Output updates now keep cell identity and code intact.
- Plain R's idle callback loop did not service JGD's native socket handlers, so Fit R device appeared to do nothing. The worker now services those handlers. Historical resize replies use the requested plot's frame and execution identity instead of the newest plot on that device.
- Disconnected clients retained their control flag, and overlapping reconnections could let an old socket clear a new connection's pending requests. Client state and cleanup now follow the current connection.
- Offline output exposed controls that could do nothing. Saved outputs mark themselves disconnected, disable agent-dependent controls, and explain reconnection.
- PNG export could run before its image was loaded. It now waits for image readiness and reports load failures.
- The earlier macOS storage permission and virtual-cell lintr cache fixes are included in the baseline commit.

## Validation

The baseline passed 291 VS Code tests before this iteration. The final local matrix ran on macOS arm64 with R 4.6.1, Node 26.10.0, arf 0.5.1, JGD 0.2.0, and tmux 3.5a. Runtime tests install the bundled sess package into private temporary libraries; they do not replace the user's installed package. tmux was built into a temporary prefix and used a private socket directory.

| Validation | Result |
| --- | --- |
| Full VS Code suite, minimum supported version 1.110.0 | 303 passed |
| Full VS Code suite, version 1.119.0, with tmux supervision enabled | 303 passed |
| Managed arf runtime matrix, also including existing arf adoption | 18 passed |
| Standard graphics fallback runtime matrix | 16 passed; 2 JGD-only checks intentionally skipped |
| Full sess tinytest suite, freshly built private package | 353 checks passed |
| Browser renderer harness and actual sandboxed widget interaction | 15 assertions passed; widget responded to a click |
| TypeScript checking and production bundles | Passed |
| TypeScript lint | 0 errors; 70 existing warnings, unchanged from the baseline |
| R source and package lint | Passed with lint failures treated as errors |
| Extension packaging | Local VSIX built successfully |

The tests cover virtual-cell/input diagnostics with disk lint caching enabled in the user profile, source-file diagnostics, execution through the native Interactive API, independent session targeting, draft retention, clearing during execution, output-only updates preserving edited code and execution summaries, durable reconnect, code deduplication, control leases, native input/debugger prompts, interrupt/stop, output limits, table paging, incremental/multiple-device graphics, idle/historical resizing, HTML dependencies, offline output, and export fallbacks. The process-persistence test exits the launcher, reconnects, and checks that R objects remain available.

Actual Remote SSH transport, Linux runtime behavior, and systemd user-service policies were not exercised on a remote host. The Linux CI workflow includes a real tmux supervision test but has not been run for this local branch. No remote latency or throughput benchmark is claimed. Existing session agents keep their original runtime until explicitly restarted; restarting loses their in-memory R objects, so new capabilities can also be tried in a new session while older work remains alive.

The renderer harness is `src/test/browser/interactiveRenderer.html`; run it against compiled assets served from the repository root. CI explicitly installs `languageserver` and `lintr` so diagnostics regressions run against real R processes.
