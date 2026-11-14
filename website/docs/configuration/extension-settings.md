# Extension settings

This page details the settings of vscode-R that can be set in VSCode's
`settings.json` file.

Please also see
[recommend extensions and configurations](../features/language-service.md),
some
[useful keyboard shortcuts](./keyboard-shortcuts.md)
and the options for the language server's formatter and linter that are detailed
[here](https://github.com/REditorSupport/languageserver#faq).

## General Editor Settings

- `r.source.encoding`: an optional encoding to pass to R when executing the file
- `r.source.focus`: keeping focus when running (editor or terminal)
- `r.sessionWatcher`: enable R session watcher
- `r.session.watchGlobalEnvironment`: watch the global environment to provide
  hover, autocompletions, and workspace viewer information
- `r.session.emulateRStudioAPI`: emulate the RStudio API for addin support and
  other {rstudioapi} calls
- `r.session.viewers.viewColumn`: which view column should R-related webviews be
  displayed?
- `r.workspaceViewer.clearPrompt`: prompt the user for confirmation when
  clearing the workspace

## Executable and Terminal Settings

- `r.executablePath`: vanilla R executable used for background processes such
  as the language server, help server, and package installation. It accepts an
  absolute or substituted path, or an executable name available on `PATH`.
- `r.consolePath`: R or an alternative console used for interactive terminals.
  It accepts the same path forms as `r.executablePath`. For new configurations,
  if it is unset, vscode-R uses `r.executablePath`, then the system R
  installation.
- `r.consoleArgs`: command line arguments passed to the interactive console
- `r.alwaysUseActiveTerminal`: use active terminal for all commands, rather than
  creating a new R terminal
- `r.bracketedPaste`: use bracketed paste mode when supported by the console
- `r.consoleSendDelay`: delay in milliseconds before sending each line to the
  console
  (only applies if r.bracketedPaste is false)

For migration from 2.x, the platform-specific `r.rpath.*` and `r.rterm.*`
settings are deprecated in favor of `r.executablePath` and `r.consolePath`.
Likewise, use `r.consoleArgs` instead of `r.rterm.option`, and
`r.consoleSendDelay` instead of `r.rtermSendDelay`.

## Plot Settings

- `r.plot.backend`: select `auto`, `standard`, `httpgd`, or `jgd`. The default
  `auto` tries JGD first, then httpgd, then the standard viewer.
- `r.plot.format`: select `svglite` or `png` for the standard plot backend
- `r.plot.devArgs`: supplementary graphics-device arguments for the standard
  backend. Width and height are managed by the responsive viewer and override
  values supplied here.
- `r.plot.jgd.historyLimit`: maximum number of plots kept in JGD history
- `r.plot.jgd.exportWidth`, `r.plot.jgd.exportHeight`, and
  `r.plot.jgd.exportDpi`: default JGD export dimensions and resolution
- `r.plot.defaults.colorTheme`: which color theme to use when launching the plot
  httpgd viewer
- `r.plot.defaults.plotPreviewLayout`: how to display plot previews if more than
  one row is required in the httpgd viewer
- `r.plot.defaults.fullWindowMode`: whether to use full window mode when
  launching the httpgd viewer
- `r.plot.timing.resizeInterval`: interval in ms to wait between plot resizes
- `r.plot.timing.refreshInterval`: interval in ms to wait between plot refreshs
- `r.plot.customStyleOverwrites`: path to a custom CSS file to be used when
  r.plot.defaults.colorTheme is 'vscode'. Replaces the default CSS overwrites!

`r.plot.useHttpgd` is deprecated. For compatibility, setting it to `true`
selects httpgd while `r.plot.backend` remains `auto`. Setting it to `false` no
longer forces the standard viewer: if that was your 2.x configuration, set
`r.plot.backend` to `"standard"` explicitly.

## Data viewer Settings

- `r.session.data.pageSize`: the number of rows requested per page in the data
  viewer. `0` disables pagination.

## R Markdown Settings

- `r.rmarkdown.enableCodeLens`: enable RMarkdown CodeLens, which are inline
  commands/buttons e.g. 'Run Chunk | Run Above' shown on the first line of each
  code chunk.
  <details>
    <summary>Details</summary>

  - Click the buttons to run commands.
  - Hover on the buttons to show tooltips.
  - CodeLens commands are customizable via settings UI (Rmarkdown: Code Lens
  commands) or settings.json `r.rmarkdown.codeLensCommands`
  </details>

- `r.rmarkdown.codeLensCommands`: Customize RMarkdown CodeLens, which are inline
  commands/buttons e.g. 'Run Chunk | Run Above' shown on the first line of each
  code chunk.
  <details>
    <summary>Details</summary>
    Available commands:

  - `r.selectCurrentChunk`
  - `r.runCurrentChunk`
  - `r.runAboveChunks`
  - `r.runCurrentAndBelowChunks`
  - `r.runBelowChunks`
  - `r.runAllChunks`
  - `r.runPreviousChunk`
  - `r.runNextChunk`
  - `r.goToPreviousChunk`
  - `r.goToNextChunk` <br>

    Customize both the commands AND its orders (that is, CodeLens respect
    user-specified orders). Default commands:

  - `r.runCurrentChunk`
  - `r.runAboveChunks`
  - `<Add item...>`
  </details>

- `r.rmarkdown.chunkBackgroundColor:` RMarkdown chunk background color in RGBA
  or RGB value.

  <details>
    <summary>Details</summary>

  Defaults to rgba(128, 128, 128, 0.1). Leave it empty to disable it (use
  default editor background color). Reload VS Code after changing settings.
  Learn how to set colors: <https://www.w3schools.com/css/css_colors_rgb.asp>

  <br><br>

  Examples for syntax `rgba(<red>, <green>, <blue>, <alpha>)`:

  - `rgba(128, 128, 128, 0.1)`
  - `rgba(128, 128, 128, 0.3)`
  - `rgba(255, 165, 0, 0.1)`
  </details>

- `r.rmarkdown.preview.autoRefresh`: Enable automatic refresh of R Markdown
  preview on file update.

## Language server settings

The following settings could be set up to deviate from the default behavior:

- `r.lsp.enabled`: Enable the R language server (default).
- `r.executablePath`: Path to the vanilla R binary used to launch the R Language
  Server and other background processes. Examples: `/usr/bin/R`
  (Linux/macOS), `C:\\Program Files\\R\\R-4.1.0\\bin\\x64\\R.exe` (Windows). If
  the setting is left blank (default), then the R path will be detected from
  the `PATH` environment variable and Windows registry. It should be _vanilla_ R
  rather than an alternative console.
- `r.lsp.args`: The command line arguments to use when launching R Language
  Server. Example: `--vanilla` to disable loading startup scripts such as
  `.Rprofile` and `Rprofile.site`.
- `r.lsp.debug`: Enable debugging traces. Defaults to `false`. Set this to
  `true` if you are having trouble getting the Language Server working.
- `r.lsp.diagnostics`: Enable linting of R code, using the
  [lintr](https://github.com/jimhester/lintr) package. Defaults to `true`. To
  disable this, you must have at least version 0.2.7 of the R Language Server
  installed.
