# Interacting with R terminals

## Creating R terminal

In VS Code window, press <kbd>F1</kbd> (or <kbd>Ctrl + Shift + P</kbd>) and
choose "R: Create R terminal" command, then the VS Code terminal will be
revealed and an R terminal will be launched.

By default, the official `R` terminal is launched.

Set `r.consolePath` to use an alternative console. For new configurations, when
it is unset, vscode-R uses `r.executablePath`, then the system R installation.

<img width="617" alt="R" src="https://user-images.githubusercontent.com/4662568/122424170-156c7800-cfc1-11eb-8e5d-748e63022440.png">

For an alternative R console, see [arf](https://github.com/eitsupi/arf).

If the R session watcher is enabled, then it will attach to the R session
whenever a new R terminal is created. The status of the session watcher is shown
in the status bar like below. Managed terminals reconnect automatically after a
VS Code window reload.

![R session status bar item](/images/r-status-bar-item.png)

## Sending code to R terminals

By default, if there is no active R terminal, then a new R terminal will be
created before sending code to it. To always send code to the active terminal
without creating a new one, turn on `r.alwaysUseActiveTerminal` in VS Code
settings.

The behavior of sending code to the terminal is following:

- If a range of code is selected, then the selected code will be sent to the
  terminal.
- If no code is selected, then an executable range of code will be sent to the
  terminal and the cursor will move to the next line.

## Using multiple R terminals

Each time "R: Create R terminal" is executed, a new R terminal is created. The
user could switch between these R terminals, and customize the icon color and
the label of each terminal.

<img width="618" alt="R terminals" src="https://user-images.githubusercontent.com/4662568/122424572-67ad9900-cfc1-11eb-9448-9bf9413b06c3.png">

To activate the session belonging to the current R terminal, click the status
bar item or run **R: Activate R Session**.

## Using self-managed R terminals

Self-managed R terminals could be useful if one needs one or more R sessions to
be preserved so that closing the VS Code window does not terminate the R
sessions. On Linux and macOS, both
[`screen`](https://www.gnu.org/software/screen/) and
[`tmux`](https://github.com/tmux/tmux/wiki) could be used to preserve any number
of R sessions or any other terminal programs in a customizable layout.

To connect one, run **R: Attach External R Session (Copy command)** in VS Code,
then paste and run the copied `source(...)` command in the target R session.
The generated script installs or updates vscode-R's bundled `sess` package if
needed and attaches the session to the current window.

The old `~/.vscode-R/init.R` startup snippet was removed in v3.0.0. Remove any
remaining block that sources it from `.Rprofile`.

## Control console print width and text wrapping

On some systems, users may notice that the full width of the R console is not being used. In the example below, we see that both the `LETTERS` vector and the columns of our dummy data frame are being hard wrapped at 80 characters, resulting in unnecessary overflow of rows instead of utilizing the available horizontal space.

<img width="845" height="410" alt="Screenshot 2025-10-03 at 2 38 03 PM" src="https://github.com/user-attachments/assets/2fd61450-ace1-484e-a335-db5ca36006c7" />

The culprit in such cases is most likely a hard-coded `width` option in your system-wide `.Rprofile`. You can check by running

```r
getOption("width")
```

Changing this width/wrapping constraint is a simple matter of overriding the default `width` option. You can provide a hard-coded value like, say, `120` or `160`. Or, you can try invoking the `"COLUMNS"` system environment variable (caveat: this may not be available on your system). Either way, you will probably want to set the sister `setWidthOnResize` option to `TRUE` at the same time, so that the prompt width dynamically adjusts along with your VS Code terminal (e.g., if you resize the window).

```r
options(width=120)                     # set hard-coded value
# options(width=Sys.getenv("COLUMNS")) # set on available columns (may not work on every system)
options(setWidthOnResize=TRUE)         # automatically reset the width if the terminal window is changed
```

<img width="845" height="410" alt="Screenshot 2025-10-03 at 2 39 50 PM" src="https://github.com/user-attachments/assets/ef926b81-bbed-4c87-8d1f-e36ffde39c6f" />


Here we have (temporarily) set the width options directly in our live R session. But you may wish to add them to your `.Rprofile` for a persistent change across sessions.
