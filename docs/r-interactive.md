# Persistent R Interactive

R Interactive runs R independently of the VS Code extension host. Each session has its own Interactive window, execution queue, environment, retained transcript, plot service, and private agent. Reloading VS Code, closing a tab, or losing an SSH connection does not terminate R.

## Remote SSH setup

Install this extension **on the remote host**. The initial implementation supports Linux and macOS; its native console bridge does not support Windows.

The remote host needs:

- R and a C compiler capable of building R packages (`r-base-dev` and `build-essential` on Debian/Ubuntu).
- Standalone Node.js 18 or newer, available to the remote extension host. The agent uses this executable rather than VS Code's Electron process.
- `tmux` for the default Linux supervisor. `systemd --user` and detached processes are optional alternatives.
- R packages `processx`, `later`, `jsonlite`, and `rstudioapi`. Install `languageserver` for language features, `jgd` and `systemfonts` for JGD graphics, `svglite` for the static fallback, and `htmlwidgets`/`htmltools` for HTML output.
- `arf` for either arf provider. The provider contract was exercised with arf 0.5.1.

For example, run in the R installation used on the server:

```r
install.packages(c(
  "processx", "later", "jsonlite", "rstudioapi", "languageserver",
  "jgd", "systemfonts", "svglite", "htmlwidgets", "htmltools"
))
```

The extension compiles its bundled `sess` into a private, content-addressed library. It does not replace your installed `sess` package. A compiler or package dependency failure appears in the **R Interactive** output channel.

Typical remote settings:

```json
{
  "r.interactive.nodePath": "/usr/bin/node",
  "r.interactive.arfPath": "/home/me/.cargo/bin/arf",
  "r.interactive.supervision": "tmux",
  "r.interactive.restore": true,
  "r.interactive.executionTarget": "auto"
}
```

Use the paths appropriate for your server. Linux `auto` selects tmux and reports an error if tmux cannot start; it does not silently weaken persistence. macOS `auto` uses a detached agent. Detached launch goes through a short-lived bootstrap so the agent leaves the editor's process tree before launch completes; VS Code debugger auto-attach settings are removed. User systemd services remain subject to the server's login/linger policy. No option preserves in-memory R objects across a host reboot or termination of the R process.

## Your tmux/arf workflow

1. Start arf in your existing tmux windows as usual.
2. Run **R: Connect Interactive to Session** and select the discovered arf PID and working directory.
3. Arf controls permission to execute visible IPC requests. Approve its prompt, or explicitly choose `:ipc send-policy allow` in that arf process if you want unattended editor submissions. The extension does not bypass this policy using silent evaluation.
4. Name the session. Its independent agent adopts the existing R process and preserves `.GlobalEnv`. An incompatible loaded `sess` is disconnected and unloaded before loading the private bridge; if another package prevents unloading, resolve that dependency in the terminal and reconnect.
5. Repeat for other tmux windows. Select an entry in **R → Interactive Sessions** to switch the active Interactive window and workspace viewer.

The agent itself also runs under the selected supervisor. Stopping your original tmux/arf process ends its R session. Stopping the agent interrupts editor integration; it is not a checkpoint of the R heap. If an adopted arf outlives a failed agent, `sess::interactive_stop()` restores its terminal callbacks so that it can be adopted again.

**R: New Persistent Interactive Session** creates either a plain background R process or a headless arf process. This is useful when you do not need a visible terminal. Multiple sessions execute concurrently; a single R session processes submitted cells serially.

## Execution and editor behavior

- **R: Open Interactive Session** opens the session picker when run from the Command Palette. The picker checks saved agents without taking control and shows live status, provider, PID, working directory, and a short session ID. Unavailable agents are omitted, while their saved history remains on disk. The picker also offers **New persistent R session**. Selecting a session in the tree opens that session directly. Cancelling the picker leaves existing sessions unchanged.
- The R session button in the Interactive toolbar shows the session name and live state. The kernel chooser uses a compact version/provider/PID description and a second line for the working directory, host, and supervision. VS Code also uses that short description as the button tooltip; it does not expose a separate tooltip or arbitrary multiline descriptions. The full R version, PID, directory, host, supervision, executable, session ID, and controlling/observing status remain available in the status-bar tooltip and **Session… → Session Details**. The presentation refreshes during startup, execution, disconnect, stop, and restart without changing the selected kernel.
- The status bar shows the selected session, activity, queued cell count, connection state, and observer status. Select it to switch sessions or answer a waiting R input prompt. Right-click a session in **Interactive Sessions** for actions on that specific session, including rename, interrupt, queued-work cancellation, detach, and restart.
- The Interactive toolbar includes **Restart**, **Session…**, **History**, and **Clear Completed**, alongside VS Code's **Interrupt** control. **Session…** opens a searchable action picker for switching/creating sessions, rename/details, queued-work cancellation, input/control, plots/export/asset cleanup, disconnect, and stop. These actions target that window's notebook, even when another session or editor has focus. On narrow windows, VS Code moves excess actions into its toolbar overflow. The controls also work in the fallback R notebook and stay out of other kernels' notebooks.
- Restart and Stop confirmations name the affected session and explain that in-memory objects will be lost. Restart is available for managed plain R and arf sessions; restart an adopted arf session in its tmux terminal, then reconnect. **Disconnect** leaves R running. **Clear Completed** retains active/queued cells, drafts, and saved history.
- When R stops, the Interactive window shows a **R session stopped** notice, including when R exits itself. Reopening the stopped session restores one notice along with its history. Restart keeps the same Interactive window, its input draft, edited cells, code, and output. A **R session restarted** boundary marks where the fresh process begins; subsequent execution uses that process. Source-document bindings and the existing kernel controls follow the replacement. A failed restart leaves an explanation and the transcript in place so it can be retried.
- **Search Interactive History** (`Ctrl+Alt+H`, or `Cmd+Alt+H` on macOS) searches admitted code in the session's durable history, including commands older than the restored window. Enter inserts a command into the input for editing and preserves any existing draft. Item buttons copy, run again, or navigate to the original source; the history button loads older matches. Disconnected and older agents use the locally restored history.
- **New Persistent Interactive Session** focuses the new session's input, preserving drafts in other sessions. Creating a target through **Run Selection** preserves source-editor focus.
- The cell toolbar provides icons for **Insert Cell Code into Interactive Input**, **Copy Cell Code**, and **Go to Interactive Cell Source**, with tooltips identifying each action. Insert preserves an existing draft; lifecycle notices cannot be inserted as executable R code. **Browse Interactive Plots** searches the plots in the restored transcript by their generating code and opens an enlarged view.
- **Cancel Queued Interactive Cells** leaves the running cell alone. **Clear Completed Interactive Cells** hides finished cells while preserving drafts, running/queued/uncertain work, and durable history. Hidden cells stay hidden during reconnect to the same view; reopening a detached view restores the history. R process exit automatically cancels undispatched cells.
- The native VS Code Interactive window provides an R input editor and execution history, without requiring Jupyter. If that window cannot be opened, a native `r-interactive` notebook is used.
- Selecting an Interactive session makes existing Run Selection/Line, source, and other R execution commands target it when `executionTarget` is `auto`. **Use Terminal for R Execution** restores terminal routing. Set `executionTarget` to `terminal` to keep terminal routing by default.
- With the default `executionTarget: auto`, running source code when no execution target is available opens **Run R code**. Choose **New R Interactive window**, **Create R terminal**, or a live persistent session (including discovered arf sessions). The captured code runs after the target is ready. Cancelling leaves the code and cursor unchanged. Rapid submissions share the chooser and terminal startup; multiline terminal submissions remain ordered. A stopped or disconnected Interactive target also opens this chooser. Explicit `terminal` mode retains terminal behavior; explicit `interactive` mode offers Interactive targets only.
- **Bind Document to Interactive Session** pins a source document to the selected session. Notebook cells and Interactive input are bound automatically. Switching tabs does not redirect an already-bound document's requests.
- The **Workspace** viewer follows the focused Interactive window or bound source document. Its header identifies the session and PID. Unbound source files keep the last selected session. Background results refresh their own session without changing the selected workspace.
- Workspace **View**, **Remove**, **Clear**, **Save**, and **Load** target the session displayed when the action starts, including across focus changes during a dialog. Object names containing spaces or quotes are supported. A stopped, restarting, or disconnected session displays its state in the viewer; detaching clears it. Expanded data viewers retain their original session.
- Code runs in `.GlobalEnv`; visible results update `.Last.value`. Output is streamed during execution. Messages, warnings, errors, and traces are represented separately from ordinary console output. Errors show their message followed by the user calls, omitting the worker, arf transport, and condition-handler scaffolding. Saved R and Jupyter notebooks retain both the message and trace.
- `readline()`, `scan()`, and `browser()` prompts appear as input requests. Canceling the input box leaves R waiting; **Reply to Interactive Input** opens it again. **Interrupt Interactive Session** signals the R process while preserving the environment when R handles the interrupt.
- R remains single-threaded. A native call that does not check interrupts may delay cancellation. Arbitrary environment inspection and table queries are not executed concurrently with user code; cached workspace information remains visible while R is busy.
- Separate language-server processes serve virtual documents with the session's R executable, library paths, and working directory. Cell and input diagnostics lint the live text with lintr's disk cache disabled, because virtual documents have no corresponding R source file. Unsaved notebook cells also use a pathless language-server URI so namespace linters do not try to read a nonexistent file; diagnostics still map to the original cell. Source-file language servers retain the user's cache setting. Live completion and hover use the owning session with short timeouts. The existing source-file language-server configuration remains available.
- A rerun creates a new execution identity and history entry. Submissions with an existing identity are deduplicated. Reconnect never resubmits code automatically. Ambiguous dispatch failures block the queue until completion or process exit establishes what happened.
- A client control lease prevents two windows from submitting simultaneously. Other clients can observe retained output; **Take Control of Interactive Session** explicitly transfers control.

External terminal output observed through the arf console bridge is retained in terminal-origin history entries. When arf invokes R task callbacks, the completed command can also be recorded. Some arf evaluation paths omit those callbacks; their output is labeled as having unavailable source and is grouped into short output batches. This does not reconstruct exact terminal execution boundaries or provide a second live editor input surface. Arf may reject editor submissions while a terminal user is typing or R is otherwise occupied.

## Rich outputs

| Output | Behavior |
| --- | --- |
| Console, warnings, errors | Incremental output with per-execution limits and explicit truncation notices |
| Base/grid/ggplot graphics | JGD frames retained by the agent and rendered as scalable SVG; independent font metrics work without a connected editor |
| Incremental graphics | Recorded execution markers associate updates with their producing cell, including extensions of an existing plot |
| Plot controls | Compact icons with labels for opening and resizing; **Save…** opens a native VS Code format picker for SVG and PNG |
| Static fallback | Captured plots when JGD/systemfonts are unavailable or `plotBackend` is `standard` |
| Data frames and matrices | Contiguous 20-row preview pages with exact counts, disabled boundary/loading controls, retry after busy errors, and an expanded data viewer with sorting/filtering; requests remain bound to their originating session |
| HTML widgets and HTML tags | Sandboxed browser output with copied local dependencies; dependencies remain after the R temporary source is gone |
| Explicit MIME | `sess::display(x, mime = "text/markdown")`, HTML, and text formats |
| Live applications | Forwarded loopback URLs opened in a viewer; applications such as Shiny still need their own running server and may occupy the R process |

JGD graphics and browser widgets have different interaction models: a static R plot can resize and export, while plotly/leaflet-style interaction comes from the widget's JavaScript. Arbitrary widget behavior that requires browser permissions or unavailable external network resources remains subject to the sandbox and server configuration.

Table paging uses arrow icons with tooltips and accessible names. **Data viewer**, **Open plot**, and **Fit R device** retain short labels alongside their icons. **Save…** opens VS Code's native format picker without changing the cell height or scroll position, followed by the file save dialog. PNG is offered after the image loads. The picker supports typing, arrow-key navigation, Enter to select, and Escape to cancel. Each output allows one pending picker, and replies to replaced or disposed outputs are ignored.

Inline numeric columns use R's `format()` with the session's `digits`, `scipen`, and `OutDec` options. For example, at the default `digits = 7`, `1417.39130434783` displays as `1417.391`. Formatting applies to each requested page, including column-wide decimal places and scientific notation, and HTML reports retain the preview's labels. Hover over a rounded value to inspect the full received number. Raw numeric values remain unchanged for calculations and the expanded data viewer's sorting/filtering; integer64 IDs and numeric-looking text remain exact. This uses base R numeric formatting, rather than class-specific printers such as tibble's pillar display.

Already-running sessions and older saved outputs also get compact numeric display after updating the extension and reloading VS Code, using an approximation of R's default seven significant digits. Exact session-option formatting is available in new sessions using the updated bundled `sess`; existing R sessions can keep running. Previously recorded previews keep their original labels, while new page requests use the current session options.

## Persistence, storage, and export

The default registry is `$XDG_STATE_HOME/vscode-r/interactive` when `XDG_STATE_HOME` is a nonempty absolute path. Otherwise, new macOS installations use `~/Library/Application Support/vscode-r/interactive`, and Linux uses `~/.local/state/vscode-r/interactive`. An existing macOS registry at `~/.local/state/vscode-r/interactive` is reused so live sessions remain discoverable; it is never moved automatically.

`r.interactive.storagePath` overrides the default. Use an absolute, writable path, and reload VS Code after changing it. Keep this directory on private, reliable storage on the R host. With Remote SSH, the path and environment belong to the remote host.

If session creation reports `EACCES`, the storage directory or an ancestor is not writable by the R host's user. For example, a root-owned `~/.local` can prevent creating the Linux-style path on macOS. New macOS installations use Application Support to avoid this problem. For a custom path, choose a writable directory using `r.interactive.storagePath` and reload. Changing this setting selects a different registry; it does not migrate existing sessions. Reuse the original setting to reconnect to sessions stored there.

Each session stores a manifest, immutable assets, and one journal directory per process generation. Private Unix sockets and credentials live in a mode-0700 runtime directory. The extension discovers existing agents after a reload and reconstructs the recent transcript. Asset URLs are regenerated through VS Code's remote forwarding support.

With `r.interactive.restore` enabled (the default), reopening the same workspace reconnects its saved sessions, even when no R source file is open. Native Interactive tabs are matched by their saved URI, since VS Code does not retain their notebook metadata across reload. This restores the existing views without opening duplicate empty tabs. A failed reconnect preserves the saved association for a later retry. Sessions remain discoverable through **R: Open Interactive Session** from another workspace or when automatic restoration is disabled. Closing a view or choosing **Disconnect** removes its automatic-restoration entry while leaving R alive.

Admission and completion records are flushed to disk. Ordinary output is buffered by the OS, so a machine crash can lose recent output. The execution ledger prevents automatic duplicate evaluation; it does not make arbitrary R code transactional. If the agent dies during a request, the outcome can remain unknown. R process death loses in-memory objects even when its transcript survives.

**Detach** and closing a notebook leave R running. **Stop** terminates R and its graphics worker; the agent serves the open retained transcript until its final client disconnects. **Restart** creates a new process generation and environment in the same window. Restart boundaries and prior generations are restored from their journals when reconnecting, with the existing replay limits applied to each generation. History search includes all admitted commands across these generations, and exports include their retained output and restart boundaries. Old plot previews, saved widgets, and plot exports remain available; old table paging and R-device resizing are disabled because their live handles belonged to the previous process. Run the code again to create live output in the new process. Session restoration remembers open connections, not deliberately detached tabs.

**Export Interactive History** supports:

- `.R`: execution history as a script;
- `.rnb`: code, execution metadata, retained output, and static plot fallbacks;
- `.ipynb`: standard Jupyter cells with portable MIME output and an R kernelspec;
- `.html`: an HTML report with a neighboring `.assets` directory containing plots and widget dependencies. Keep the two together.

Choose the format first, then choose the destination in the save dialog. This also avoids macOS appending the wrong extension when several save filters are supplied. History and plot exports suggest names based on the session and default to its working directory. Expanded output tabs are named **Plot: session** or **Viewer: session** to distinguish them from the Interactive window.

A saved `.rnb` contains no agent authentication token or forwarded asset URL. Table previews and static plot fallbacks can be read offline. Full interactive widgets and live table handles require reconnection to the originating session; use HTML export when sharing self-contained widget dependencies. IPYNB export retains standard MIME fallbacks; live session handles remain specific to R Interactive.

Saved output disables controls that need an agent and explains how to reconnect. PNG export waits for the plot image to finish loading. Late plot updates preserve the cell's identity and any unsubmitted code edits. Fit R device works while plain R is idle and keeps historical plots associated with their original cells.

New agent capabilities such as persistent rename, full-history search, and compressed asset management require a session started with this build. Existing agents keep running with their original code. Reloading VS Code updates editor behavior, including the queued-cell output fix, but does not update an existing agent. Start a new session to use the storage improvements without disturbing old work, or explicitly restart a managed session when its in-memory objects are no longer needed. Restart prepares and loads the current private R runtime. History search falls back to the restored transcript on older agents. Renaming updates the session list, status bar, and kernel label; an already-open native tab may retain its original title until reopened.

Output journals default to 128 MiB per R generation, per-execution output to 4 MiB, and assets to **4 GiB per session** (`r.interactive.maxAssetBytes`). Asset usage counts the stored, compressed bytes. Recent-window replay is also bounded. Truncation is explicit; admission records remain for deduplication.

Plot storage follows this lifecycle:

- Incremental JGD drawing updates are combined over 200 ms, and pending updates for an execution are flushed when it finishes. The agent saves SVG snapshots; it keeps JGD's drawing operations in memory for live plot handling instead of also saving redundant JSON frame files.
- Generated SVG/JSON assets of at least 4 KiB use gzip when it reduces their size. Identical content is deduplicated. Display and export decode transparently; exported SVG/JSON files remain ordinary files. Existing uncompressed assets remain readable. HTML dependencies retain their original encoding and directory structure.
- Automatic cleanup starts when a write would exceed 80% of the quota. It removes superseded snapshots and unreferenced generated assets. The latest display version in every retained journal generation is protected, including all dependencies of retained HTML widgets. When journal rotation removes an output's last reference, its assets become eligible for cleanup. A corrupt or unreadable journal prevents cleanup.
- **R: Clean Up Interactive Assets**, also in the session context menu, runs cleanup immediately and reports reclaimed space and current usage. Clearing cells only hides them; it does not erase durable history or make their final plots eligible for cleanup.
- The hard limit still applies when all remaining assets are referenced. A failed plot retention is reported once per execution, and R keeps running. Increasing `r.interactive.maxAssetBytes` updates connected sessions that support asset management and that this window controls, without restarting R. Lowering it below protected output size is rejected.

Cleanup preserves distinct historical plots; it is not an age-based policy that silently discards them. For example, the 53,940-point faceted diamonds regression produces an SVG of about 12.4 MiB, stored as roughly 0.5 MiB after compression, with one final snapshot remaining after cleanup. Thousands of similar plots fit within the default quota. To release all storage for unused work, export it and remove that **stopped** session's storage directory. Do not delete live session storage.

## Development and validation

```sh
npm run pretest
npm run test:interactive
VSCR_TEST_PROVIDER=arf ARF_PATH=/path/to/arf npm run test:interactive
VSCR_TEST_STATIC=1 npm run test:interactive
VSCR_TEST_TMUX=1 npm run test:interactive
npx vscode-test --run out/test/suite/interactiveEditor.test.js
```

After compiling, serve the repository on localhost and open `src/test/browser/interactiveRenderer.html` to run the browser renderer regression harness. It checks contiguous paging, stale responses, retry behavior, offline controls, Unicode SVG, SVG/PNG export, menu navigation and disposal, image failures, and sandboxed HTML. Use `?theme=light&width=narrow` or `?theme=contrast` for layout/theme checks; verify native Tab/Shift+Tab and Enter/Space manually. See [the Positron comparison and review](r-interactive-review.md) for the feature priorities and verification results.

The tmux test must run on a host with tmux. Linux CI exercises a real tmux-supervised agent. Runtime tests cover output while disconnected, deduplicated execution, large Unicode writes, control leases, queues, native input, interruption, browser continuation, tables, incremental plots, HTML, detached launch, and adoption of an existing arf process. Tests build the bundled package into isolated libraries.

The local validation host was macOS with R 4.6.1, arf 0.5.1, JGD 0.2.0, and tmux 3.5a. The complete extension suite passed on VS Code 1.110.0 and 1.119.0. A browser check also exercises SVG rendering, table paging, sandboxed HTML interaction, offline controls, and canvas PNG export. Actual Remote SSH transport, Linux execution, and server-specific systemd policies were not exercised on a remote server. See [the live-testing report](r-interactive-live-testing.md) and [the review](r-interactive-review.md#validation) for the matrix and limitations.
