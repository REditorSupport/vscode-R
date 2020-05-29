# R support for Visual Studio Code

Requires [R](https://www.r-project.org/).

## Usage

Full document is on the [Wiki page](https://github.com/Ikuyadeu/vscode-R/wiki)

* For Windows, if `r.rterm.windows` is empty, then the path to `R.exe` will be searched in Windows registry. If your R is not installed with path written in registry or if you need a specific R executable path, set it to a path like `"C:\\Program Files\\R\\R-3.3.4\\bin\\x64\\R.exe"`.
* For Radian console, enable config `r.bracketedPaste`
* Open your *folder* that has R source file (**Can't work if you open only file**)
* Use `F1` key and `R:` command or `Ctrl+Enter` (Mac: `⌘+Enter`)

## Features

* Run Source(`Ctrl+Shift+S` or Push icon![icon](images/FileDownload.png)) and Run Selected Line (`Ctrl+Enter`)
* Run `nrow`, `length`, `head`, `thead`, `names` functions (`Ctrl` + `1`, `2`, `3`, `4`, `5`)
  * If you are using Mac `Ctrl` to `⌘`

![use Run .R](images/feature.png)

* R Integrated Terminal

![Create R terminal](images/terminal.png)

* Run code in terminal containing existing R session, for example over SSH (`Run Selection/Line in Active Terminal`)
* Run all commands in terminal containing existing R session (enable config `r.alwaysUseActiveTerminal`)

![R over SSH](images/ssh.gif)

* Extended Syntax(R, R Markdown, R Documentation)

![Syntax](images/Rsyntax.png)

* Create .gitignore based [R.gitignore](https://github.com/github/gitignore/raw/master/R.gitignore)

* Data frame viewer and Environment viewer(`Preview Data frame` or `Preview Environment`)

![Image](./images/DataframePreview.gif)

* Snippets

* Package development short cut (`Load All`, `Test Package`, `Install Package`, `Build Package` and `Document`)

* Bind keys to custom R commands using command runner functions (`r.runCommand`, `r.runCommandWithEditorPath`, `r.runCommandWithSelectionOrWord`)

## Requirements

* R base from <https://www.r-project.org/>

## Extension Settings

This extension contributes the following settings:

* `r.rterm.windows`: set to R.exe path for Windows
* `r.rterm.mac`: set to R term's path for Mac OS X
* `r.rterm.linux`: set to R term's path for Linux
* `r.rpath.lsp`: set to R.exe path for Language Server Protocol
* `r.rterm.option`: R command line options (i.e: --vanilla)
* `r.source.encoding`: An optional encoding to pass to R when executing the file
* `r.source.focus`: Keeping focus when running (editor or terminal)
* `r.alwaysUseActiveTerminal`: Use active terminal for all commands, rather than creating a new R terminal
* `r.bracketedPaste`: For consoles supporting bracketed paste mode (such as Radian)
* `r.sessionWatcher`: Enable R session watcher (experimental)
* `r.rtermSendDelay`: Delay in milliseconds before sending each line to rterm (only applies if r.bracketedPaste is false)

* Language server(developing [here](https://github.com/REditorSupport/languageserver))

## R Session Watcher (Experimental)

*This experimental feature is still under development and the behavior
**may change without notice**. Please file an issue [here](https://github.com/Ikuyadeu/vscode-R/issues) if you experience problems or have any suggestions.*

An opt-in experimental R session watcher is implemented to support the following features:

* Watch any R session
* Show value of session symbols on hover
* Provide completion for session symbols
* `View()` any objects including data frames and list objects
* Show plot output on update and plot history
* Show htmlwidgets, documentation and shiny apps in WebView

### Basic usage

To enable this feature, turn on `r.sessionWatcher` in VSCode settings, reload or restart VSCode, and the session watcher will be activated automatically
on R sessions launched by vscode-R via `R: Create R Terminal` command.

*If you previously appended the `source(...)` line to `~/.Rprofile`, you may safely remove it since the configuration for basic usage is automated. It is
now only necessary for advanced usage described below.*

### Advanced usage (for self-managed R sessions)

For advanced users to work with self-managed R sessions (e.g. manually launched R terminal or started in `tmux` or `screen` window), some extra
configuration is needed. Follow the steps below to make R session watcher work with any external R session:

1. Turn on `r.sessionWatcher` in VSCode settings.
2. Edit `.Rprofile` in your home directory by running the following code in R:

    ```r
    file.edit("~/.Rprofile")
    ```

3. Append the following code to the file:

    ```r
    source(file.path(Sys.getenv(if (.Platform$OS.type == "windows") "USERPROFILE" else "HOME"), ".vscode-R", "init.R"))
    ```

4. Restart or Reload Window in VSCode

If the workspace folder you open in VSCode already has a `.Rprofile`, you need to append the code above in this file too because `~/.Rprofile` will not
be executed when a local `.Rprofile` is found.

The script only works with environment variable `TERM_PROGRAM=vscode`. the script will not take effect with R sessions started in a `tmux` or `screen` window that does not have it, unless this environment variable is manually set before sourcing `init.R`, for example, you may insert a line `Sys.setenv(TERM_PROGRAM="vscode")` before it.

### How to disable it

For the case of basic usage, turning off `r.sessionWatcher` in VSCode settings is sufficient
to disable R session watcher.

For the case of advanced usage, user should, in addition, comment out or remove the `source(...)` line appended to `~/.Rprofile`.

### How it works

* When vscode-R is activated with session watcher enabled, it deploys the initialization script to `~/.vscode-R/init.R`.
* vscode-R watches `~/.vscode-R/request.log` for requests from user R sessions.
* When a new R session is created, it sources `init.R` to initialize the session watcher and writes attach request to `~/.vscode-R/request.log`.
* vscode-R reads the attach request and knows the working directory and session temp directory (`{tempDir}`) of the attaching session.
* vscode-R watches `{tempDir}/vscode-R/globalenv.json` for global environment info and `{tempDir}/vscode-R/plot.png` for plot graphics.
* In the R session, the global environment info will be updated on each evaluation of top-level expression.
* When user creates or updates a plot, the `{tempDir}/vscode-R/plot.png` is updated, and vscode-R will open the plot file.
* When user calls `View()` with a data frame, list, environment, or any other object, the request is written to `~/.vscode-R/request.log` and
vscode-R will open a WebView to show the data or open a text document to show the content of the object.
* When user calls the viewer (e.g. htmlwidget, provis) or browser (e.g. shiny app, HTML help documentation), the request is written to `~/.vscode-R/request.log` and vscode-R will open a WebView to present the viewer content.

R sessions started from the workspace root folder or a subfolder will be automatically attached. The session watcher is designed to work in a wide range of scenarios:

* Official R terminal or `radian` console
* R session started by vscode-R or user
* R session in a `tmux` or `screen` window
* Multiple R sessions in VSCode terminal
* Multiple R sessions in `tmux` windows or panes.
* Multi-root workspace in VSCode
* Switch between multiple running R sessions
* [Remote Development](https://code.visualstudio.com/docs/remote/remote-overview) via SSH, WSL and Docker

The status bar item shows the process id of the attached R session. Click the status bar item and it will
attach to currently active session.

![Attached R process](./images/RStatusBarItem.png)

![R session watcher](https://user-images.githubusercontent.com/4662568/70815935-65391480-1e09-11ea-9ad6-7ebbebf9a9c8.gif)

*The R terminal used in the screenshot is [radian](https://github.com/randy3k/radian) which is cross-platform and
supports syntax highlighting, auto-completion and many other features.*

## Creating keybindings for R commands

There are 3 ways you can use extension functions to create keybindings that run R commands in the terminal:

1. `r.runCommand` to make a keybinding to run any R expression.
2. `r.runCommandWithEditorPath` to create a keybinding for an R expression where the placeholder value `$$` is interpolated with the current file path.
3. `runCommandWithSelectionOrWord` to create a keybinding for an R expression where `$$` is interpolated with the current selection or the current word the cursor is on.

Here are some example entries from `keybindings.json`:

```json
[
    {
        "description": "run drake::r_make()",
        "key": "ctrl+;",
        "command": "r.runCommand",
        "when": "editorTextFocus",
        "args": "drake::r_make()"
    },
    {
        "description": "load drake target at cursor",
        "key": "ctrl+shift+;",
        "command": "r.runCommandWithSelectionOrWord",
        "when": "editorTextFocus",
        "args": "drake::loadd($$)"
    },
    {
        "description": "knit to html",
        "key": "ctrl+i",
        "command": "r.runCommandWithEditorPath",
        "when": "editorTextFocus",
        "args": "rmarkdown::render(\"$$\", output_format = rmarkdown::html_document(), output_dir = \".\", clean = TRUE)"
    }
]
```

## TODO

* Debug

## CONTRIBUTING

* Please see [CONTRIBUTING.md](https://github.com/Ikuyadeu/vscode-R/blob/master/CONTRIBUTING.md)

This extension based on

* [r.tmbundle](https://github.com/textmate/r.tmbundle)
* [markdown-redcarpet.tmbundle](https://github.com/streeter/markdown-redcarpet.tmbundle)
* [Markdown extension in VS Code](https://github.com/Microsoft/vscode/blob/master/extensions/markdown/snippets/markdown.json)
* [R.gitignore](https://github.com/github/gitignore/raw/master/R.gitignore)
* [language-r](https://github.com/lee-dohm/language-r)
* [R box](https://github.com/randy3k/R-Box)

## Collaborators

I hope you will join us.

* [@andycraig](https://github.com/andycraig)
* [@Ladvien](https://github.com/Ladvien)
* [@renkun-ken](https://github.com/renkun-ken)

## FAQ

* Q: I can't use command and message is `xxx no command found`.
* A: Please open your folder that has R source file

* Q: About code formatter, completion, definition...
* A: Please visit to the language server [issues](https://github.com/REditorSupport/languageserver/issues)

Other past questions can be found from [StackOverflow](https://stackoverflow.com/questions/tagged/visual-studio-code+r) or [issues](https://github.com/Ikuyadeu/vscode-R/issues)

The R logo is © 2016 The R Foundation
