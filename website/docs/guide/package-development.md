# Package development

Package development is supported by vscode-R,
[R language server](https://github.com/REditorSupport/languageserver), and
[R debugger](https://github.com/ManuelHentschel/VSCode-R-Debugger).

## Commands

vscode-R mainly provides the mostly used package development commands:

| Title           | Command      | R code                 |
| --------------- | ------------ | ---------------------- |
| Build package   | `r.build`    | `devtools::build()`    |
| Test package    | `r.test`     | `devtools::test()`     |
| Check package   | `r.check`    | `devtools::check()`    |
| Install package | `r.install`  | `devtools::install()`  |
| Document        | `r.document` | `devtools::document()` |
| Load all        | `r.loadAll`  | `devtools::load_all()` |


Keyboard shortcuts could be bound to these commands. See
[Creating keybindings for R commands](../configuration/keyboard-shortcuts.md#creating-keybindings-for-r-commands).

## Development

The [R language server](https://github.com/REditorSupport/languageserver) loads
all R documents in `./R` if it detects a `NAMESPACE` file in the workspace root
folder, which indicates that the workspace contains an R package. Therefore, all
these R files are considered in the same workspace, sharing completions,
definitions, references, and other workspace-level language features.

## Debugging

The [R debugger](https://github.com/ManuelHentschel/VSCode-R-Debugger) supports
debugging the package code in the current workspace. See
[Debugging R packages](https://github.com/ManuelHentschel/VSCode-R-Debugger#debugging-r-packages)
for more details.
