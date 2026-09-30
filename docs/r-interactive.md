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

Use the paths appropriate for your server. Linux `auto` selects tmux and reports an error if tmux cannot start; it does not silently weaken persistence. macOS `auto` uses a detached agent. User systemd services remain subject to the server's login/linger policy. No option preserves in-memory R objects across a host reboot or termination of the R process.

## Your tmux/arf workflow

1. Start arf in your existing tmux windows as usual.
2. Run **R: Connect Interactive to Session** and select the discovered arf PID and working directory.
3. Arf controls permission to execute visible IPC requests. Approve its prompt, or explicitly choose `:ipc send-policy allow` in that arf process if you want unattended editor submissions. The extension does not bypass this policy using silent evaluation.
4. Name the session. Its independent agent adopts the existing R process and preserves `.GlobalEnv`. An incompatible loaded `sess` is disconnected and unloaded before loading the private bridge; if another package prevents unloading, resolve that dependency in the terminal and reconnect.
5. Repeat for other tmux windows. Select an entry in **R → Interactive Sessions** to switch the active Interactive window and workspace viewer.

The agent itself also runs under the selected supervisor. Stopping your original tmux/arf process ends its R session. Stopping the agent interrupts editor integration; it is not a checkpoint of the R heap. If an adopted arf outlives a failed agent, `sess::interactive_stop()` restores its terminal callbacks so that it can be adopted again.

**R: New Persistent Interactive Session** creates either a plain background R process or a headless arf process. This is useful when you do not need a visible terminal. Multiple sessions execute concurrently; a single R session processes submitted cells serially.

## Execution and editor behavior

- The native VS Code Interactive window provides an R input editor and execution history, without requiring Jupyter. If that window cannot be opened, a native `r-interactive` notebook is used.
- Selecting an Interactive session makes existing Run Selection/Line, source, and other R execution commands target it when `executionTarget` is `auto`. **Use Terminal for R Execution** restores terminal routing. Set `executionTarget` to `terminal` to keep terminal routing by default.
- **Bind Document to Interactive Session** pins a source document to the selected session. Notebook cells and Interactive input are bound automatically. Switching tabs does not redirect an already-bound document's requests.
- Code runs in `.GlobalEnv`; visible results update `.Last.value`. Output is streamed during execution. Messages, warnings, errors, and traces are represented separately from ordinary console output.
- `readline()`, `scan()`, and `browser()` prompts appear as input requests. Canceling the input box leaves R waiting; **Reply to Interactive Input** opens it again. **Interrupt Interactive Session** signals the R process while preserving the environment when R handles the interrupt.
- R remains single-threaded. A native call that does not check interrupts may delay cancellation. Arbitrary environment inspection and table queries are not executed concurrently with user code; cached workspace information remains visible while R is busy.
- Separate language-server processes serve virtual documents with the session's R executable, library paths, and working directory. Cell and input diagnostics lint the live text with lintr's disk cache disabled, because virtual documents have no corresponding R source file. Source-file language servers retain the user's cache setting. Live completion and hover use the owning session with short timeouts. The existing source-file language-server configuration remains available.
- A rerun creates a new execution identity and history entry. Submissions with an existing identity are deduplicated. Reconnect never resubmits code automatically. Ambiguous dispatch failures block the queue until completion or process exit establishes what happened.
- A client control lease prevents two windows from submitting simultaneously. Other clients can observe retained output; **Take Control of Interactive Session** explicitly transfers control.

External terminal output observed through the arf console bridge is retained in terminal-origin history entries. When arf invokes R task callbacks, the completed command can also be recorded. Some arf evaluation paths omit those callbacks; their output is labeled as having unavailable source and is grouped into short output batches. This does not reconstruct exact terminal execution boundaries or provide a second live editor input surface. Arf may reject editor submissions while a terminal user is typing or R is otherwise occupied.

## Rich outputs

| Output | Behavior |
| --- | --- |
| Console, warnings, errors | Incremental output with per-execution limits and explicit truncation notices |
| Base/grid/ggplot graphics | JGD frames retained by the agent and rendered as scalable SVG; independent font metrics work without a connected editor |
| Incremental graphics | Recorded execution markers associate updates with their producing cell, including extensions of an existing plot |
| Plot controls | Open a larger view, request an R-side resize while idle, save SVG, or export PNG |
| Static fallback | Captured plots when JGD/systemfonts are unavailable or `plotBackend` is `standard` |
| Data frames and matrices | Inline preview, paging, and an expanded data viewer with sorting/filtering; requests remain bound to their originating session |
| HTML widgets and HTML tags | Sandboxed browser output with copied local dependencies; dependencies remain after the R temporary source is gone |
| Explicit MIME | `sess::display(x, mime = "text/markdown")`, HTML, and text formats |
| Live applications | Forwarded loopback URLs opened in a viewer; applications such as Shiny still need their own running server and may occupy the R process |

JGD graphics and browser widgets have different interaction models: a static R plot can resize and export, while plotly/leaflet-style interaction comes from the widget's JavaScript. Arbitrary widget behavior that requires browser permissions or unavailable external network resources remains subject to the sandbox and server configuration.

## Persistence, storage, and export

The default registry is `$XDG_STATE_HOME/vscode-r/interactive` when `XDG_STATE_HOME` is a nonempty absolute path. Otherwise, new macOS installations use `~/Library/Application Support/vscode-r/interactive`, and Linux uses `~/.local/state/vscode-r/interactive`. An existing macOS registry at `~/.local/state/vscode-r/interactive` is reused so live sessions remain discoverable; it is never moved automatically.

`r.interactive.storagePath` overrides the default. Use an absolute, writable path, and reload VS Code after changing it. Keep this directory on private, reliable storage on the R host. With Remote SSH, the path and environment belong to the remote host.

If session creation reports `EACCES`, the storage directory or an ancestor is not writable by the R host's user. For example, a root-owned `~/.local` can prevent creating the Linux-style path on macOS. New macOS installations use Application Support to avoid this problem. For a custom path, choose a writable directory using `r.interactive.storagePath` and reload. Changing this setting selects a different registry; it does not migrate existing sessions. Reuse the original setting to reconnect to sessions stored there.

Each session stores a manifest, immutable assets, and one journal directory per process generation. Private Unix sockets and credentials live in a mode-0700 runtime directory. The extension discovers existing agents after a reload and reconstructs the recent transcript. Asset URLs are regenerated through VS Code's remote forwarding support.

Admission and completion records are flushed to disk. Ordinary output is buffered by the OS, so a machine crash can lose recent output. The execution ledger prevents automatic duplicate evaluation; it does not make arbitrary R code transactional. If the agent dies during a request, the outcome can remain unknown. R process death loses in-memory objects even when its transcript survives.

**Detach** and closing a notebook leave R running. **Stop** terminates R and its graphics worker; the agent serves the open retained transcript until its final client disconnects. **Restart** creates a new process generation and environment. Session restoration remembers open connections, not deliberately detached tabs.

**Export Interactive History** supports:

- `.R`: execution history as a script;
- `.rnb`: code, execution metadata, retained output, and static plot fallbacks;
- `.ipynb`: standard Jupyter cells with portable MIME output and an R kernelspec;
- `.html`: an HTML report with a neighboring `.assets` directory containing plots and widget dependencies. Keep the two together.

A saved `.rnb` contains no agent authentication token or forwarded asset URL. Table previews and static plot fallbacks can be read offline. Full interactive widgets and live table handles require reconnection to the originating session; use HTML export when sharing self-contained widget dependencies. IPYNB export retains standard MIME fallbacks; live session handles remain specific to R Interactive.

Output journals default to 128 MiB, per-execution output to 4 MiB, and assets to 512 MiB per session. Recent-window replay is also bounded. Truncation is explicit; admission records remain for deduplication. Asset quota exhaustion rejects new assets rather than deleting dependencies referenced by earlier outputs. Export and remove an unused **stopped** session's storage directory to reclaim its disk space, or adjust the limits. Do not delete live session storage.

## Development and validation

```sh
npm run pretest
npm run test:interactive
VSCR_TEST_PROVIDER=arf ARF_PATH=/path/to/arf npm run test:interactive
VSCR_TEST_STATIC=1 npm run test:interactive
VSCR_TEST_TMUX=1 npm run test:interactive
npx vscode-test --run out/test/suite/interactiveEditor.test.js
```

The tmux test must run on a host with tmux. Linux CI exercises a real tmux-supervised agent. Runtime tests cover output while disconnected, deduplicated execution, large Unicode writes, control leases, queues, native input, interruption, browser continuation, tables, incremental plots, HTML, detached launch, and adoption of an existing arf process. Tests build the bundled package into isolated libraries.

The local validation host was macOS with R 4.6.1, arf 0.5.1, JGD 0.2.0, and VS Code 1.119.0. A browser smoke check also exercises SVG rendering, table previews, sandboxed HTML interaction, and canvas PNG export. Remote SSH latency, server-specific systemd policies, the minimum VS Code version, and Linux tmux are covered by the implementation/CI path but were not manually exercised on a remote server in this workspace.
