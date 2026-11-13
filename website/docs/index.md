---
layout: home
title: R Extension for Visual Studio Code
titleTemplate: false

hero:
  name: vscode-R
  text: R Extension for Visual Studio Code
  tagline: Language service based on static code analysis, and interactivity between VS Code and R sessions.
  image:
    src: /logo.svg
    alt: R logo
  actions:
    - theme: brand
      text: Getting Started
      link: /getting-started
    - theme: alt
      text: Windows
      link: /installation/windows
    - theme: alt
      text: macOS
      link: /installation/macos
    - theme: alt
      text: Linux
      link: /installation/linux
---

<div class="vp-doc home-content">

[vscode-R](https://github.com/REditorSupport/vscode-R) is the R Extension for
[Visual Studio Code](https://code.visualstudio.com/). The extension is mainly
focused on providing language service based on static code analysis and user
interactivity between VS Code and R sessions.

We recommend the [Getting Started](./getting-started.md) page first. Or, dive in
straight away by choosing the installation instructions for your operating
system: [Windows](./installation/windows.md), [macOS](./installation/macos.md),
or [Linux](./installation/linux.md).

## Features

- Snippets for R and R Markdown.

- [R Language Service](./features/language-service.md):
  Code completion, function signature, symbol highlight, document outline,
  formatting, definition, diagnostics, references, and more.

- [Interacting with R terminals](./features/r-terminals.md):
  Sending code to terminals, running multiple terminals, working with remote
  servers.

- [R Interactive](./features/r-interactive.md) (experimental):
  Persistent R sessions with native Interactive windows and rich output.

- [Package development](./guide/package-development.md):
  Build, test, install, load all and other commands from devtools.

- [Keyboard shortcuts](./configuration/keyboard-shortcuts.md):
  Built-in and customizable keyboard shortcuts.

- [Workspace viewer](./features/sidebar.md#workspace-viewer):
  Environment pane to show global variables in the attached R session.

- [Help pages viewer](./features/sidebar.md#help-pages-viewer):
  Viewing R help pages and searching help topics.

- [Package management](./features/sidebar.md#package-management):
  Installing and removing R packages.

- Session symbol hover and completion.

- [Data viewer](./features/interactive-viewers.md#data-viewer):
  Viewing data frames, matrices, Arrow tables, and Polars DataFrames in a
  sortable, filterable grid that loads rows on demand, or lists as JSON.

- [Plot viewer](./features/plot-viewer.md):
  Interactive JGD and httpgd backends, plus a responsive standard SVG/PNG
  viewer.

- [Webpage viewer](./features/interactive-viewers.md#webpage-viewer):
  Viewing [htmlwidgets](https://www.htmlwidgets.org) such as interactive
  graphics and [visual profiling results](https://rstudio.github.io/profvis/).

- [Browser viewer](./features/interactive-viewers.md#browser-viewer):
  Viewing interactive [shiny](https://shiny.rstudio.com) apps.

- [R Markdown support](./guide/r-markdown.md):
  R Markdown chunk highlighting, chunk navigation, execute commands, and
  preview.

- [RStudio add-in support](./features/rstudio-addins.md):
  Run supported RStudio add-ins in VS Code with a live R session.

- Full support of
  [Remote Development](https://code.visualstudio.com/docs/remote/remote-overview)
  via [SSH](https://code.visualstudio.com/docs/remote/ssh),
  [Containers](https://code.visualstudio.com/docs/remote/containers) and
  [WSL](https://code.visualstudio.com/docs/remote/wsl).

</div>

<style>
.home-content {
  max-width: 1152px;
  margin: 48px auto 0;
  padding: 0 24px;
}
@media (min-width: 640px) {
  .home-content { padding: 0 48px; }
}
@media (min-width: 960px) {
  .home-content { padding: 0 64px; }
}
</style>
