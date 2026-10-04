# Persistent R Interactive

R Interactive runs R independently of the VS Code extension host. Each session has its own Interactive window, execution queue, environment, retained transcript, plot service, and private agent. Reloading VS Code, closing a tab, or losing an SSH connection does not terminate R.

R Interactive and its `r.interactive.*` settings are experimental. Configuration and behavior may change as the design evolves.

## Remote SSH setup

Install this extension **on the remote host**. The initial implementation supports Linux and macOS; its native console bridge does not support Windows.

The remote host needs:

- R, plus either compatible pre-built sess/dependency packages or a C compiler capable of building R packages (`r-base-dev` and `build-essential` on Debian/Ubuntu).
- The session agent automatically uses the extension host's bundled runtime: VS Code's Electron runtime in Node mode on desktop, or VS Code Server's Node runtime remotely. A separate Node.js installation is optional.
- `tmux` is optional. On Linux, the default supervisor uses tmux when available and otherwise starts an independent detached process. `systemd --user` is another configurable option.
- R packages `processx`, `later`, `jsonlite`, and `rstudioapi`. Install `languageserver` for language features, `jgd` and `systemfonts` for JGD graphics, `svglite` for the static fallback, and `htmlwidgets`/`htmltools` for HTML output.
- `arf` is optional. Creating a headless arf session requires an executable on the R host; plain R requires no arf installation. Connecting to an already-running arf uses its socket and does not require arf on the extension host's PATH. The provider contract was exercised with arf 0.5.1.

For example, run in the R installation used on the server:

```r
install.packages(c(
  "processx", "later", "jsonlite", "rstudioapi", "languageserver",
  "jgd", "systemfonts", "svglite", "htmlwidgets", "htmltools"
))
```

The experimental `r.interactive.nodePath` setting provides an optional standalone Node.js override for compatible IDEs where the automatic runtime is unavailable, such as some code-server, OpenVSCode Server, or VSCodium configurations. Its default is empty, which selects the current extension host's runtime. Set it to a Node.js 18+ executable name on the R host's PATH or a path such as `/usr/bin/node`; `~`, `${userHome}`, and `${workspaceFolder}` are supported. An invalid explicit override is reported and must be repaired or cleared. The override is excluded from Settings Sync and restricted to trusted workspaces.

Runtime availability and version (Node.js 18+) are checked before installation or restart, so a failed check leaves the current R process running. If an editor update removes the automatic runtime, reload VS Code to select its current executable. Reconnecting to an existing agent does not launch or replace its runtime; new and restarted sessions reread `r.interactive.nodePath`.

The extension installs its bundled `sess` into a private, content-addressed library. It does not replace your installed `sess` package. If the source build fails, including when build tools are missing, it tries a compiler-free package from [R-universe](https://reditorsupport.r-universe.dev/sess). Installation diagnostics appear in the **R Interactive** output channel.

The fallback uses R's matching macOS/Windows binary repository, or an Ubuntu repository matching the host's codename, architecture and R version. It never assumes that an Ubuntu binary is compatible with a different Linux distribution. Where no binary target exists, a published pure-R package can also be used without compilation, provided its dependencies are already installed or available without compilation. Dependencies for a binary fallback come from the matching R-universe repositories. No global repository settings are changed.

Interactive requires the published package's compatibility marker (`Config/vscode-R/Interactive: 1`), the expected public exports and internal entry points, and the registered native console routines. A matching package version alone is insufficient. **The public sess 3.0.1 build checked on 2026-10-02 predates this PR, reports `NeedsCompilation: no`, and cannot run these Interactive sessions.** A build containing this branch's native bridge must be published before that fallback can replace local compilation for Interactive. Ordinary terminal sess installation can already use the existing public build. Missing/incompatible binaries produce an actionable installation error rather than a partially initialized session.

That private library is used only to load the bridge; it is not added to your session's `.libPaths()` or `R_LIBS`. Package installation follows ordinary R behavior: `install.packages()` defaults to the first library in `.libPaths()`, usually your user library. Startup files can customize that order, and an explicit `lib=` still takes precedence. The extension does not force a user-library destination over a project library.

Start the session in the renv project directory to load its `.Rprofile` normally. An activated renv project keeps its project library, installation destination, and package isolation; the private `sess` is not added to `renv::snapshot()` lockfiles. IDE support namespaces and the plot device load explicitly, preferring available project versions of their dependencies and using normal host libraries as a fallback. This does not make unrelated packages from those host libraries visible to the project. Install analysis packages in the project as usual, and record them with renv. As in any R process, an already-loaded dependency keeps its loaded version until restart.

Sessions created by older extension builds retain their original library order. Start a new session after updating to use this behavior. Restarting also applies it, but clears in-memory R objects; switching directories in an existing R session does not itself activate a different renv project.

Typical remote settings:

```json
{
  "r.interactive.arfPath": "/home/me/.cargo/bin/arf",
  "r.interactive.supervision": "auto",
  "r.interactive.restore": true,
  "r.interactive.executionTarget": "auto"
}
```

Executable paths, storage location, supervision, graphics backend, and output/journal/asset size limits are excluded from VS Code Settings Sync by default because they depend on the R host. Execution target, table presentation, automatic reconnection, and history-length preferences can still sync.

Use the paths appropriate for your server. Linux `auto` prefers tmux when its executable is on the extension host's PATH. If tmux is missing or not executable, it uses a detached agent and records the fallback in the **R Interactive** output channel and agent log. Session Details shows **Independent process**. macOS `auto` also uses a detached agent. Both plain R and managed arf support this fallback with the same Interactive features.

Selecting `tmux` or `systemd` explicitly requires `tmux` or `systemd-run` on the R host. Missing executables produce an actionable error before installing a runtime or stopping the current R process for restart. Install the selected supervisor or change `r.interactive.supervision` to `auto` or `detached`. New sessions and restarts use the current setting; merely reconnecting leaves the existing supervisor unchanged. If an installed supervisor fails to launch (for example, a systemd user service is unavailable), the error includes its diagnostics. The extension does not retry with another supervisor after a launch attempt, which could create duplicate R processes.

Detached launch goes through a short-lived bootstrap so the agent leaves the editor's process tree before launch completes; VS Code debugger auto-attach settings are removed. It survives VS Code reload/exit and an SSH connection closing, but server policies that terminate a user's processes at logout can still stop it. User systemd services also depend on the server's login/linger policy. No option preserves in-memory R objects across a host reboot or termination of the R process.

## Connect to an existing arf session

Adoption uses arf's session discovery and IPC socket on the R host. It does not depend on a particular terminal multiplexer or session manager.

1. Start arf in your preferred terminal or session manager as usual.
2. Run **R: Connect Interactive to Session** and select the discovered arf PID and working directory.
3. Arf controls permission to execute visible IPC requests. Approve its prompt, or explicitly choose `:ipc send-policy allow` in that arf process if you want unattended editor submissions. The extension does not bypass this policy using silent evaluation.
4. Name the session. Its independent agent adopts the existing R process and preserves `.GlobalEnv`. An incompatible loaded `sess` is disconnected and unloaded before loading the private bridge; if another package prevents unloading, resolve that dependency in the terminal and reconnect.
5. Repeat for other arf sessions. Select an entry in **R → Interactive Sessions** to switch the active Interactive window and workspace viewer.

The agent itself runs under the separately selected supervisor (`tmux`, `systemd`, or a detached process). Stopping your original arf process ends its R session. Stopping the agent interrupts editor integration; it is not a checkpoint of the R heap. If an adopted arf outlives a failed agent, `sess::interactive_stop()` restores its terminal callbacks so that it can be adopted again.

**R: New Persistent Interactive Session** creates either a plain background R process or a headless arf process. This is useful when you do not need a visible terminal. Multiple sessions execute concurrently; a single R session processes submitted cells serially.

The provider picker shows **R** and **arf**, each with its resolved executable path on a second line. **arf** appears only when `r.interactive.arfPath` resolves to an executable file on this host (the remote server with Remote SSH). Otherwise, **Configure arf…** opens its setting without creating a session. Install arf separately and configure its path, or choose **R** with the same persistence and multi-session controls. The setting accepts names on PATH, absolute or workspace-relative paths, `~/`, `${userHome}`, and `${workspaceFolder}`. Configured paths containing spaces do not need quotes. Changing the setting takes effect the next time the picker opens; shell aliases are not executables.

New arf sessions save their resolved absolute executable path, so a later PATH change does not break restart. Restart checks that saved path, then the current setting if the executable moved, before stopping R. If neither is usable, it explains how to configure arf and leaves the current session running.

## Execution and editor behavior

- **R: Open Interactive Session** opens the session picker when run from the Command Palette. The picker checks saved agents without taking control and shows live status, provider, PID, working directory, and a short session ID. Unavailable agents are omitted, while their saved history remains on disk. The picker also offers **New persistent R session**. Selecting a session in the tree opens that session directly. Cancelling the picker leaves existing sessions unchanged.
- The R session button in the Interactive toolbar shows the session name and live state. The kernel chooser uses a compact version/provider/PID description and a second line for the working directory, host, and supervision. VS Code also uses that short description as the button tooltip; it does not expose a separate tooltip or arbitrary multiline descriptions. The full R version, PID, directory, host, supervision, executable, session ID, and controlling/observing status remain available in the status-bar tooltip and **Session… → Session Details**. The presentation refreshes during startup, execution, disconnect, stop, and restart without changing the selected kernel.
- The status bar shows the selected session, activity, queued cell count, connection state, and observer status. Select it to switch sessions or answer a waiting R input prompt. Right-click a session in **Interactive Sessions** for actions on that specific session, including rename, interrupt, queued-work cancellation, detach, and restart.
- The **Interactive Sessions** tooltip separates **Connection: Connected · controlling/observing** from process supervision. **Independent process** means R survives VS Code reload/exit; it does not mean the editor is disconnected. Unopened sessions show **Not open in this VS Code window**. Connection/control changes refresh the tooltip, including after reconnecting.
- Session age appears in the session list, connection/stop pickers, and kernel description as **<1m**, **30m**, **1h**, or **1d**. It refreshes once a minute; the tooltip includes the start time. Age uses the persisted start of the current process generation, so reloading preserves it and restarting resets it. Agents started with this build also record process exit time, keeping a stopped session's lifetime fixed.
- **R: Stop Selected Interactive Sessions…** in the Command Palette opens a checkbox picker with session names, PIDs, and directories. Use Ctrl/Cmd-click or Shift-click to select entries in **Interactive Sessions**, then click the header's stop icon or right-click **Stop Selected Interactive Sessions…** to stop that selection. With no tree selection, the header icon opens the picker. **R: Stop All Interactive Sessions…**, also in the view's **…** menu, targets running Interactive sessions in the configured registry on this host, including those without open tabs. Both ask once with the target list, retain history, and leave the current editor layout intact. Sessions controlled by another VS Code window are skipped; the result offers **Show Details** for failures. Use **Take Control** explicitly before retrying those sessions. Sessions created or restarted after confirmation opens are not added to its targets.
- The Interactive toolbar includes **Restart**, **Session…**, **History**, and **Clear Completed**, alongside VS Code's **Interrupt** control. **Session…** opens a searchable action picker for switching/creating sessions, rename/details, queued-work cancellation, input/control, plots/export/asset cleanup, disconnect, and stop. These actions target that window's notebook, even when another session or editor has focus. On narrow windows, VS Code moves excess actions into its toolbar overflow. The controls also work in the fallback R notebook and stay out of other kernels' notebooks.
- Restart and Stop confirmations name the affected session and explain that in-memory objects will be lost. Restart is available for managed plain R and arf sessions; restart an adopted arf session in its original terminal or session manager, then reconnect. **Disconnect** leaves R running. **Clear Completed** retains active/queued cells, drafts, and saved history.
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
- Separate language-server processes serve virtual documents with the session's R executable, library paths, and working directory. Cell and input diagnostics lint the live text with lintr's disk cache disabled, because virtual documents have no corresponding R source file. Blank or whitespace-only Interactive prompts clear diagnostics and ignore late lint replies; nonempty code and source files still receive normal diagnostics. Unsaved notebook cells also use a pathless language-server URI so namespace linters do not try to read a nonexistent file; diagnostics still map to the original cell. Source-file language servers retain the user's cache setting. Live completion and hover use the owning session with short timeouts. The existing source-file language-server configuration remains available.
- Custom `.lintr` linter lists in cells and inputs require the pathless-document settings fix in `languageserver`. Released versions such as 0.3.20 still select default linters for these documents, even when source files use your configured rules. Updating the extension alone does not fix that package behavior.
- Function hovers and parameter hints can use the owning session's cached function metadata, including while R is busy. After executing `fun1 <- function(x, y) x + y`, hovering over `fun1` shows its formals, and typing `fun1(` or `fun1(1, ` shows and highlights the corresponding parameter. Hints handle defaults, named arguments, `...`, nested expressions, and quoted names. Source-local definitions and package signatures from languageserver take priority. Session hints are a fallback for simple function names in source documents, notebook cells, and Interactive inputs; they do not evaluate code. Different sessions can define the same name with different signatures.
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
| Data frames and matrices | On-demand inline pages (20/50/100 rows), first/last and page jumps, sorting, column filters/reordering and Reset; an expanded data viewer remains available. Requests stay bound to their originating session |
| HTML widgets and HTML tags | Sandboxed browser output with copied local dependencies; dependencies remain after the R temporary source is gone |
| Explicit MIME | `sess::display(x, mime = "text/markdown")`, HTML, and text formats |
| Live applications | Forwarded loopback URLs opened in a viewer; applications such as Shiny still need their own running server and may occupy the R process |

When one cell produces multiple plots, the output uses one paged plot viewer with **Previous plot**, **Plot n of m**, and **Next plot** controls. New plots appear on the latest page until you choose a page. Your choice is retained across output updates and reconnection. **Open**, **Save…**, and **Fit R device** act on the selected page; standard graphics images support Open and Save but have no live resize control. Pagination remains available in saved notebooks and after R stops or restarts. R notebook exports retain the gallery; Jupyter and HTML exports include every plot page.

Table headings and values use the same alignment: numbers (including integer64 IDs) are right aligned and text is left aligned. **Text** switches a table to its ordinary R printout; **Table** switches back. The printout uses the object's class printer and the R print options at execution time, so data.table retains its type labels and tibble retains its usual compact printing. Switching does not execute R, and remains available while R is busy or stopped and in saved notebooks. Set `r.interactive.tableView` to `"text"` to use printed output by default, or `"table"` for the paged preview. Per-output choices override that default and survive reconnection. Explicit `print(x)` still produces normal console output.

Printed snapshots require a session started with this extension build; older output explains why Text is unavailable. Snapshots retain at most 256 KiB of printed text, with a truncation notice. If a custom printer fails, the rich table remains available and the Text tooltip explains the failure. Live table paging and the full data viewer still require the original R process.

Data inspection does not initialize or advance R's random-number stream, so opening a table between `set.seed()` and a simulation or train/test split leaves the draws unchanged. Inline tables retain a snapshot of up to **1,000 rows**, reduced to fit **100,000 cells** for wide tables (at least one row). Row subsetting gives data.table snapshots independent columns without a full deep copy. Later `:=`, `setnames()`, and `setorder()` calls do not change those saved rows. Reference assignments remain quiet like the R console; evaluate `DT` or use `DT[, x := value][]` to display the result, or call `View()` / `sess::display()` explicitly.

The saved snapshot is **not a browsing limit**. The inline status initially shows **Saved preview** and the full row count; its tooltip and Text output identify the saved scope, for example **Snapshot: first 1,000 of 832,976,871 rows**. Moving beyond those rows automatically fetches a page from the uncopied original object and changes the status to **Live data**. Once browsing live data, navigation stays live until Reset. Later edits by reference can appear in these pages. The handle retains the original object; assigning a different object to the same variable does not retarget an old viewer.

- Use **First**, **Previous**, **Next**, **Last**, or enter a page number and press **Go** / Enter. Choose **20**, **50**, or **100 rows** per page. Only the current fetched page is kept in the renderer; paging does not accumulate the dataset in browser memory.
- Click a column heading to cycle ascending, descending, and original order. **Filters** offers operators appropriate to the R column type, including missing values, dates, booleans and exact integer64 values. Press **Apply** to run a filter; typing does not query R. Filters on different columns combine with AND, and each active filter has a remove button. Text comparisons are case-insensitive and use literal text.
- Drag column headings to reorder them. Reordering changes presentation locally and leaves R data unchanged.
- **Reset** restores the saved first page, 20 rows, original column order, and clears sorting, filters and unfinished filter text. It works locally after R stops and ignores outstanding replies. It does not interrupt an R operation already running; use the session's Interrupt control for that.

Sorting and filtering a large table use the **full dataset**, even from the saved preview. They can scan all rows and allocate query indices; plain paging does neither. Cached queries are reused while paging and invalidated after R execution. When starting a new live query, a changed column schema clears incompatible sorting/filtering. If columns change during ordinary live navigation, use Reset and browse beyond the preview again to refresh, or reopen **Data viewer**. The expanded viewer opens the same full object without copying it and is labelled **Full data**.

Inline page/query/order choices survive output updates in the current window, within a bounded cache of recently used tables. They are temporary: reloads and exports use the original saved output. The Text/Table preference is persisted separately. Live requests require the original R process; stopped or archived cells retain their available page and local Reset/Text/column controls. Sessions with the bounded-snapshot/full-data handles already support these editor-side controls after reloading VS Code. Older output without a full-data handle cannot dynamically expand a truncated snapshot.

Column-header tooltips show R classes and storage types. Actual `NA` and `NaN` values have muted italic labels and explanatory tooltips, distinct from the literal string `"NA"`. Small nested values use readable JSON instead of `[object Object]`; large or deeply nested list cells show their class and size. Text previews shorten strings beyond 1,000 characters with a truncation marker. This prevents a single nested dataset or long string from creating an enormous cell. Inspect the original object in R for its complete contents. Full-view filters use the original string, including text beyond the displayed prefix. Numeric labels continue to use R's formatting without changing the values used in calculations.

Full-table handles retain their original objects in R memory without an additional deep copy. Closing an expanded viewer or clearing completed cells does not release a handle that remains in the transcript. Distinct historical objects can therefore still retain substantial memory; use summaries or explicit `print(DT)` if you do not need a full-data handle. R's usual copy-on-modify rules still apply to later edits of shared ordinary data frames. The default Text view changes presentation only. The asset quota limits disk storage, not R heap usage.

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

Retention limits are configured in MiB (1 MiB = 1,048,576 bytes):

```json
{
  "r.interactive.maxAssetSizeMiB": 1024,
  "r.interactive.maxJournalSizeMiB": 128,
  "r.interactive.maxOutputSizeMiB": 4
}
```

These defaults allow **1 GiB of assets per session**, approximately 128 MiB of output journal per R generation, and 4 MiB of console text per execution. Fractional MiB values are supported and converted to whole bytes. Asset usage counts stored bytes after compression where supported. Output and journal setting changes apply to new or restarted sessions. The asset limit also updates connected sessions controlled by this window without restarting R.

These limits do not cap total session storage: earlier R generations and execution records (including submitted code) remain separately retained. Journal rotation removes old output in roughly 4 MiB segments. Reopening a window restores about 3 MiB of recent execution data per R generation, independently of these retention limits, so a retained execution's full output may not fit in the restored window. Truncation is explicit; admission records remain for deduplication.

Plot storage follows this lifecycle:

- Incremental JGD drawing updates are combined over 200 ms, and pending updates for an execution are flushed when it finishes. The agent saves SVG snapshots; it keeps JGD's drawing operations in memory for live plot handling instead of also saving redundant JSON frame files.
- Generated SVG/JSON assets of at least 4 KiB use gzip when it reduces their size. Identical content is deduplicated. Display and export decode transparently; exported SVG/JSON files remain ordinary files. Existing uncompressed assets remain readable. HTML dependencies retain their original encoding and directory structure.
- Automatic cleanup starts when a write would exceed 80% of the quota. It removes superseded snapshots and unreferenced generated assets. The latest display version in every retained journal generation is protected, including all dependencies of retained HTML widgets. When journal rotation removes an output's last reference, its assets become eligible for cleanup. A corrupt or unreadable journal prevents cleanup.
- **R: Clean Up Interactive Assets**, also in the session context menu, runs cleanup immediately and reports reclaimed space and current usage. Clearing cells only hides them; it does not erase durable history or make their final plots eligible for cleanup.
- The hard limit still applies when all remaining assets are referenced. A failed plot retention is reported once per execution, and R keeps running. Increasing `r.interactive.maxAssetSizeMiB` updates connected sessions that support asset management and that this window controls, without restarting R. Lowering it below protected output size is rejected.

Cleanup preserves distinct historical plots; it is not an age-based policy that silently discards them. For example, the 53,940-point faceted diamonds regression produces an SVG of about 12.4 MiB, stored as roughly 0.5 MiB after compression, with one final snapshot remaining after cleanup. Thousands of similar plots fit within the default quota. To release all storage for unused work, export it and remove that **stopped** session's storage directory. Do not delete live session storage.

## Development and validation

Install the pinned pnpm version following [the contributor setup](../CONTRIBUTING.md#debugging-the-extension), then run:

```sh
pnpm install --frozen-lockfile
pnpm run pretest
pnpm run test:interactive
VSCR_TEST_PROVIDER=arf ARF_PATH=/path/to/arf pnpm run test:interactive
VSCR_TEST_STATIC=1 pnpm run test:interactive
VSCR_TEST_TMUX=1 pnpm run test:interactive
pnpm exec vscode-test --run out/test/suite/interactiveEditor.test.js
```

After compiling, serve the repository on localhost and open `src/test/browser/interactiveRenderer.html` to run the browser renderer regression harness. It checks contiguous paging, stale responses, retry behavior, offline controls, Unicode SVG, SVG/PNG export, menu navigation and disposal, image failures, and sandboxed HTML. Use `?theme=light&width=narrow` or `?theme=contrast` for layout/theme checks; verify native Tab/Shift+Tab and Enter/Space manually. See [the Positron comparison and review](r-interactive-review.md) for the feature priorities and verification results.

The tmux test must run on a host with tmux. Linux CI exercises a real tmux-supervised agent. Runtime tests cover output while disconnected, deduplicated execution, large Unicode writes, control leases, queues, native input, interruption, browser continuation, tables, incremental plots, HTML, detached launch, and adoption of an existing arf process. Tests build the bundled package into isolated libraries.

The local validation host was macOS with R 4.6.1, arf 0.5.1, JGD 0.2.0, and tmux 3.5a. The latest complete extension suite runs on VS Code 1.140.0; earlier passes cover 1.110.0 and 1.119.0. Browser checks exercise SVG rendering, table paging, sandboxed HTML interaction, offline controls, and canvas PNG export. Research workflows cover cleaning, summaries, inference, model fitting, diagnostics, resampling, and data/model export with both providers and standard graphics. Actual Remote SSH transport and server-specific systemd policies were not exercised on a remote server. See [the research review](r-interactive-research-review.md), [live-testing report](r-interactive-live-testing.md), and [earlier review](r-interactive-review.md#validation) for the matrix and limitations.
