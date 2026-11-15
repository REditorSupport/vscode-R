# Recommended extensions and configuration

In addition to the setup detailed in the
[Getting Started](../getting-started.md)
page, or the configuration available in the
[settings page](./extension-settings.md),
users may be interested in further configuration to match the experience of
other editors like RStudio. Many of these are features that vscode-R does not
directly control, but are possible to handle through VSCode and the libraries
vscode-R interfaces with. We suggest some of those options here.

## R console, plots, and companion extensions

- [arf](https://github.com/eitsupi/arf) is a modern R console with syntax
  highlighting, multiline editing, vi/emacs keybindings, and R version
  switching. It is a successor to [radian](https://github.com/randy3k/radian)
  written in Rust.
- [jgd](https://github.com/REditorSupport/jgd) and
  [httpgd](https://github.com/nx10/httpgd) provide interactive plots in the
  [plot viewer](../features/plot-viewer.md). If jgd is not installed, vscode-R
  can offer to install it into a vscode-R-managed library without changing your
  R libraries.
- The [Quarto](https://marketplace.visualstudio.com/items?itemName=quarto.quarto)
  extension adds support for Quarto documents, and
  [VSCode-R-Debugger](https://github.com/ManuelHentschel/VSCode-R-Debugger)
  enables VS Code's debugging facilities for R scripts.

For example, with arf and jgd installed, your user `settings.json` might
include:

```jsonc
{
  "r.consolePath": "arf",
  "r.bracketedPaste": true, // recommended for arf and radian
  "r.plot.backend": "jgd" // "auto" already prefers jgd, then httpgd
}
```

## Formatting

User's `settings.json` file in VSCode can be configured to format on save:

```json
{
  "[r]": {
    "editor.defaultFormatter": "REditorSupport.r",
    "editor.formatOnSave": true
  },
  "[rmd]": {
    "editor.defaultFormatter": "REditorSupport.r",
    "editor.formatOnSave": true
  }
}
```

## Linting

It's also useful to set some sensible defaults for the R linter. These can be
configured in a `.lintr` file at your computer's `HOME` directory (or
`USERPROFILE` if you are on Windows), or in your current project.

The following example allows commented code, which is often a necessity, and
prevents checking if objects are in global scope, since this can throw
[extraneous errors](https://github.com/r-lib/lintr/issues/482) if functions from
libraries are called.

```dcf
linters: with_defaults(
  object_usage_linter = NULL,
  commented_code_linter = NULL)
```

See the
[`lintr` docs](https://lintr.r-lib.org/articles/lintr.html)
for more configuration details and rules.

## Dots in variable/function names

Treat `names.like.this` as one word for selection.

In VSCode's `settings.json`, add the following:

```json
"[r]": {
    "editor.wordSeparators": "`~!@#%$^&*()-=+[{]}\\|;:'\",<>/?"
}
```

## C/C++

We recommend the
[C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)
VSCode extension with the following settings to write Rcpp:

In `.vscode/c_cpp_properties.json`:

```json
{
  "configurations": [
    {
      "name": "Linux",
      "includePath": [
        "${workspaceFolder}/**",
        "${env:HOME}/R/x86_64-pc-linux-gnu-library/3.6/Rcpp/include",
        "/usr/share/R/include"
      ],
      "defines": [],
      "compilerPath": "/usr/bin/gcc",
      "cStandard": "c11",
      "cppStandard": "c++17",
      "intelliSenseMode": "clang-x64"
    }
  ],
  "version": 4
}
```

`.clang-format`:

```yaml
---
Language: Cpp
BasedOnStyle: LLVM
Standard: Cpp11
ReflowComments: false
---
```

In your `settings.json`:

```json
"C_Cpp.commentContinuationPatterns": [
    "/**",
    "//'"
]
```

See demonstration and more tooling at
[renkun-ken/vscode-rcpp-demo](https://github.com/renkun-ken/vscode-rcpp-demo)

## Path Autocomplete

We recommend the VSCode extension
[Path Autocomplete](https://marketplace.visualstudio.com/items?itemName=ionutvmi.path-autocomplete)
with the following configuration in `settings.json` to enable autocompletion for
file names:

```json
"path-autocomplete.pathMappings": {
    "/": "/",
    "./": "${folder}"
}
```

## Error Lens

You can use the
[Error Lens](https://marketplace.visualstudio.com/items?itemName=usernamehw.errorlens)
extension for more visible error messages.
