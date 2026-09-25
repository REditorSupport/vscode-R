# R Extension for Visual Studio Code

<!-- badges: start -->

<a href="https://marketplace.visualstudio.com/items?itemName=reditorsupport.r"><img src="https://img.shields.io/github/v/release/REditorSupport/vscode-R?label=release" alt="Release"></a>
<a href="https://github.com/REditorSupport/vscode-R/releases/tag/latest"><img src="https://img.shields.io/github/package-json/v/REditorSupport/vscode-R/master?label=dev" alt="Development version"></a>
<a href="https://github.com/REditorSupport/vscode-R/actions/workflows/main.yml"><img src="https://img.shields.io/github/actions/workflow/status/REditorSupport/vscode-R/main.yml?branch=master&label=ci" alt="CI"></a>

<!-- badges: end -->

This [VS Code](https://code.visualstudio.com/) extension provides support for the [R programming language](https://www.r-project.org), including features such as R language service based on code analysis, interacting with R terminals, viewing data, plots, workspace variables, help pages, managing packages, and working with [R Markdown](https://rmarkdown.rstudio.com/) documents. See the [wiki](https://github.com/REditorSupport/vscode-R/wiki) for full documentation.

The R and R Markdown syntaxes are located in a sibling package [vscode-R-syntax](https://github.com/REditorSupport/vscode-R-syntax).

## What's new in 3.0.0-rc

v3.0.0 of the R Extension for VS Code is a major release. It introduces a
significant architectural change via the [**`sess`**](./sess/README.md) R
package, which powers faster and more robust communication with the underlying R
session. `sess` is bundled with the extension and installed automatically if it
is missing or outdated, so no manual setup is needed.

## Quickstart

1. [Install R](https://cloud.r-project.org/) (>= 3.4.0) on your system. On Windows, we recommend letting the installer write the R path to the registry.

2. Install the [`languageserver`](https://github.com/REditorSupport/languageserver) package from R.

    ```r
    install.packages("languageserver")
    ```

3. Install the stable release of this extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=reditorsupport.r) or the [Open VSX Registry](https://open-vsx.org/extension/reditorsupport/r).

    ```sh
    code --install-extension REditorSupport.r
    ```

    Alternatively, you can test the latest development version by installing from GitHub:

    <details>
    <summary>Install the development version</summary>

    The [`latest`](https://github.com/REditorSupport/vscode-R/releases/tag/latest)
    pre-release is rebuilt from every push to `master`. Download and install it:

    ```sh
    curl -fsSL -o vscode-R.vsix \
      https://github.com/REditorSupport/vscode-R/releases/download/latest/vscode-R.vsix
    code --install-extension vscode-R.vsix
    ```

    </details>

4. Create an R file and start coding! (Click **Yes** if prompted to install `sess`.)

### Recommended extras

Steps 1–3 above are all that's required to get started with R in VS Code. But we also recommend the following software for a fully optimized R + VS Code experience:

* Install an interactive plotting backend for a better R graphics experience:
    * [jgd](https://github.com/grantmcdermott/jgd): Lightweight JSON graphics device with native vscode-R integration.
    * [httpgd](https://github.com/nx10/httpgd): SVG-based graphics device served via HTTP and WebSockets.

* [arf](https://github.com/eitsupi/arf): A modern R console with many features: syntax highlighting, multiline editing, vi/emacs keybindings, R version switching, etc. Successor to [radian](https://github.com/randy3k/radian) written in Rust.

* Complementary VS Code extensions:
   * [Quarto](https://marketplace.visualstudio.com/items?itemName=quarto.quarto): the official Quarto plugin for VS Code.
   * [VSCode-R-Debugger](https://github.com/ManuelHentschel/VSCode-R-Debugger): enables VS Code's debugging facilities for R scripts.

For example, assuming that you have installed `arf` and `jgd`, your user `settings.json` might include:

```jsonc
{
    "r.consolePath": "arf",
    "r.bracketedPaste": true,  // recommended for arf (and radian)
    "r.plot.backend": "jgd"    // "auto" already prefers jgd, then httpgd
}
```

Please consult the relevant installation wiki pages for your OS ([Windows](https://github.com/REditorSupport/vscode-R/wiki/Installation:-Windows) | [macOS](https://github.com/REditorSupport/vscode-R/wiki/Installation:-macOS) | [Linux](https://github.com/REditorSupport/vscode-R/wiki/Installation:-Linux)) for more detailed instructions.

## Features

* Snippets for R and R Markdown.

* [R Language Service](https://github.com/REditorSupport/vscode-R/wiki/R-Language-Service): Code completion, function signature, symbol highlight, document outline, formatting, definition, diagnostics, references, and more.

* [Interacting with R terminals](https://github.com/REditorSupport/vscode-R/wiki/Interacting-with-R-terminals): Sending code to terminals, running multiple terminals, working with remote servers.

* [Package development](https://github.com/REditorSupport/vscode-R/wiki/Package-development): Build, test, install, load all and other commands from devtools.

* [Keyboard shortcuts](https://github.com/REditorSupport/vscode-R/wiki/Keyboard-shortcuts): Built-in and customizable keyboard shortcuts.

* [Workspace viewer](https://github.com/REditorSupport/vscode-R/wiki/Sidebar-user-interface#workspace-viewer): Environment pane to show global variables in the attached R session.

* [Help pages viewer](https://github.com/REditorSupport/vscode-R/wiki/Sidebar-user-interface#help-pages-viewer): Viewing R help pages and searching help topics.

* [Package management](https://github.com/REditorSupport/vscode-R/wiki/Sidebar-user-interface#package-management): Installing and removing R packages.

* Session symbol hover and completion.

* [Data viewer](https://github.com/REditorSupport/vscode-R/wiki/Interactive-viewers#data-viewer): Viewing data frames, matrices, Arrow tables, and polars data frames in a paged, sortable, filterable grid; lists in a tree view.

* [Plot viewer](https://github.com/REditorSupport/vscode-R/wiki/Plot-viewer): Interactive plot viewer with support for [jgd](https://github.com/grantmcdermott/jgd) and [httpgd](https://github.com/nx10/httpgd) backends, plus a standard PNG/SVG fallback.

* [Webpage viewer](https://github.com/REditorSupport/vscode-R/wiki/Interactive-viewers#webpage-viewer): Viewing [htmlwidgets](https://www.htmlwidgets.org) such as interactive graphics and [visual profiling results](https://rstudio.github.io/profvis/).

* [Browser viewer](https://github.com/REditorSupport/vscode-R/wiki/Interactive-viewers#browser-viewer): Viewing interactive [shiny](https://shiny.rstudio.com) apps.

* [R Markdown support](https://github.com/REditorSupport/vscode-R/wiki/R-Markdown): R Markdown chunk highlighting, chunk navigation, execute commands, and preview.

* [RStudio add-in support](https://github.com/REditorSupport/vscode-R/wiki/RStudio-addin-support): Run supported RStudio add-ins in VS Code with a live R session.

* Full support of [Remote Development](https://code.visualstudio.com/docs/remote/remote-overview) via [SSH](https://code.visualstudio.com/docs/remote/ssh), [Containers](https://code.visualstudio.com/docs/remote/containers) and [WSL](https://code.visualstudio.com/docs/remote/wsl).

## Questions, issues, feature requests, and contributions

* If you have a question about accomplishing something in general with the extension, please [start a discussion](https://github.com/REditorSupport/vscode-R/discussions) or [ask on Stack Overflow](https://stackoverflow.com/questions/tagged/visual-studio-code+r).

* If you find a problem or have a feature request with the extension, please [find out](https://github.com/REditorSupport/vscode-R/issues) if there is a current issue you may upvote or otherwise [file an issue](https://github.com/REditorSupport/vscode-R/issues/new/choose).

* Contributions are always welcome! Please see the [contributing guide](https://github.com/REditorSupport/vscode-R/wiki/Contributing) for more details.
