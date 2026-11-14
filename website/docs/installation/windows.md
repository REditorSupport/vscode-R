# Installation: Windows

## vscode-R

Install
[vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) in VS
Code by searching `reditorsupport.r` in extension marketplace.

vscode-R requires VS Code 1.101 or later. The first time a managed R
terminal starts, accept the prompt to install the bundled `sess` R package.

If your R installation is from [CRAN](http://cran.r-project.org/mirrors.html)
with default installation settings, especially **Save version number in
registry** is enabled, as the following image shows:

<img width="500" alt="image" src="https://user-images.githubusercontent.com/4662568/76700772-ca94ee00-66f5-11ea-97bc-f89afeaf1bd3.png">

Then the default settings should work out of the box. Otherwise, set
`r.consolePath` to the R console executable used by **R: Create R terminal**.
Use `r.executablePath` separately if background processes require a different,
vanilla R executable.

## languageserver

[languageserver](https://github.com/REditorSupport/languageserver) is an
implementation of the
[Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
for R.

Run the following commands in R.

You may install the latest stable release from CRAN:

```r
install.packages("languageserver")
```

or install the development version with the newest features:

```r
remotes::install_github("REditorSupport/languageserver")
```

which requires [Rtools](https://cran.r-project.org/bin/windows/Rtools/) to
build.

You can also install the `rmarkdown` package and Pandoc rendering library to see
formatted R help pages upon [hover](../features/language-service.md#hover). Previews of function documentation
without these dependencies will show a plain page.

`rmarkdown` can be installed with:

```r
install.packages("rmarkdown")
```

Pandoc is
[automatically installed](https://alexd106.github.io/intro2R/install_rmarkdown.html)
if you have RStudio on your machine. See the official installation guide
[here](https://pandoc.org/installing.html) if you do not have RStudio.

## VSCode-R-Debugger

[VSCode-R-Debugger](https://marketplace.visualstudio.com/items?itemName=RDebugger.r-debugger)
is a VS Code extension that implements R debugging capabilities. It depends on
[vscDebugger](https://github.com/ManuelHentschel/vscDebugger).

1. Install VSCode-R-Debugger extension in VS Code.
2. Install vscDebugger package via

```r
remotes::install_github("ManuelHentschel/vscDebugger")
```

## Plot backends

vscode-R supports two optional interactive plot backends:

- [JGD](https://github.com/REditorSupport/jgd) is lightweight, has no external
  R-package dependencies, and is usually simpler to install.
- [httpgd](https://github.com/nx10/httpgd) provides a mature, feature-rich SVG
  viewer over HTTP and WebSockets, but has a larger compiled dependency
  footprint.

Install either or both:

```r
install.packages("jgd")
install.packages("httpgd", repos = c("https://nx10.r-universe.dev", "https://cran.r-project.org"))
```

Leave `r.plot.backend` at its default value, `"auto"`, to try JGD first, then
httpgd, then the standard viewer. You can instead set it explicitly to `"jgd"`
or `"httpgd"`. See [Plot viewer](../features/plot-viewer.md) for details.

## Troubleshooting WSL

The connection between VSCode and R may fail if an R session is started on
Windows Subsystem for Linux (WSL/WSL2), but VSCode is started outside of the WSL
environment (e.g. on plain Windows). For R to work, you must open VSCode _on
WSL_ with the `code <directory>` command so that VSCode "thinks" that it is
inside the container.

See issue [#910](https://github.com/REditorSupport/vscode-R/issues/910) for
details.
