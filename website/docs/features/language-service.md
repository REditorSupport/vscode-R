# R Language Service

The
[R language server](https://github.com/REditorSupport/languageserver#servers-implemented)
implements the
[Language Server Protocol](https://microsoft.github.io/language-server-protocol/specifications/specification-current/)
and provides a set of language analysis features such as completion, providing
function signatures, extended function documentation, locating function
implementations, occurrences of a symbol or object, and code diagnostics and
formatting. The R language server statically analyzes R code, and vscode-R
interfaces with it to provide the core of this extension's functionality.

The R language server is implemented by the
[languageserver](https://github.com/REditorSupport/languageserver) package which
performs static code analysis with the latest user documents in `R` and `Rmd`
languages. Therefore, it does not rely on an active R session and thus does not
require the code to be executed.

To install the package from CRAN:

```r
install.packages("languageserver")
```

To experience the latest features, install the package from GitHub:

```r
remotes::install_github("REditorSupport/languageserver")
```

### Settings

See the
[extension settings page](../configuration/extension-settings.md)
for information on configuring the language server.

## Features

The R language server contributes the following features.

- [Smart editing](#smart-editing)
  - [Autocompletion while typing](#autocompletion)
  - [Function signature preview while typing](#signature-preview)
  - [Extended documentation on hover](#hover)
  - [Diagnose potential errors and unreliable code with `lintr`](#diagnostics)
  - [Format with `styler` for clean and consistent code](#formatting)
  - [Symbol renaming, powered up](#rename-symbol)
- [Document organization](#document-organization)
  - [Symbol highlighting on cursor focus](#symbol-highlight)
  - [Structure-aware document selection](#document-selection)
  - [Code sections and folding](#code-sections)
  - [Call hierarchy analysis](#call-hierarchy)
- [Document navigation](#document-navigation)
  - [Navigate through all R objects in workspace](#document-and-workspace-symbols)
  - [Find all occurrences of an object](#find-all-occurrences)
  - [Document names are links](#document-links)
  - [See implementation](#go-to-definition)
- [Miscellaneous](#miscellaneous)
  - [Color picker](#color-picker)

---

## Smart editing

---

### Autocompletion

The R language server provides global and scope-based autocompletion. You can
scroll through the suggested signatures with the arrow keys.

Global autocompletion:

![Completion](https://user-images.githubusercontent.com/4662568/71432969-6fb3b200-2717-11ea-89a6-244cc7e38abf.gif)

Scope-based autocompletion:

![Scope completion](https://user-images.githubusercontent.com/4662568/71432977-717d7580-2717-11ea-9c2e-f76c811e6f0d.gif)

The R language server currently does not provide completion for filenames; see
this
[comment.](../configuration/recommended-extensions.md#path-autocomplete).

### Signature preview

The R language server provides popups of function signatures and their short
descriptions as you type, which can save a few calls to `help()`.

![Package function signature](https://user-images.githubusercontent.com/4662568/71432976-717d7580-2717-11ea-898f-4eecfebe97b3.png)

![User function signature](https://user-images.githubusercontent.com/4662568/71432978-72160c00-2717-11ea-95fe-8b2d1930c7a9.png)

### Hover

A larger preview of the documentation is shown when users mouse over R symbols:

![Hover](https://user-images.githubusercontent.com/4662568/71432974-70e4df00-2717-11ea-9f89-bfe5a363dbd3.gif)

### Diagnostics

The language server provides code diagnostics through the
[lintr](https://lintr.r-lib.org/) package in R. See
[here](../configuration/code-linting.md)
for configuration.

![Diagnostics](https://user-images.githubusercontent.com/4662568/71432971-704c4880-2717-11ea-9ceb-fc35a091d839.png)

### Formatting

The language server provides code formatting through the
[`styler`](https://github.com/r-lib/styler) package in R. See
[here](https://github.com/REditorSupport/languageserver#customizing-formatting-style)
for configuration.

![Formatting](https://user-images.githubusercontent.com/4662568/71432972-70e4df00-2717-11ea-86b4-2da317e1376b.gif)

![On-type-formatting](https://user-images.githubusercontent.com/4662568/74438354-f0379900-4ea4-11ea-9743-99e8a8950d40.gif)

### Rename symbol

Symbol renaming through the language server allows you to group renaming actions
together, letting you refactor code more easily and discard a change on the fly
if need be.

![Rename symbol](https://user-images.githubusercontent.com/4662568/93668953-ef15bc80-fac2-11ea-9ea6-21e2e98517a1.gif)

---

## Document organization

---

### Symbol highlight

When the cursor is inside of a symbol, all occurrences of that symbol within the
document are highlighted.

![Symbol highlight](https://user-images.githubusercontent.com/4662568/71432973-70e4df00-2717-11ea-906c-050ac17d79a7.gif)

### Document selection

You can expand selections through `Shift+Alt+RightArrow`. Selections are
expanded in steps, following the boundaries of each containing R expression.

![Selection range](https://user-images.githubusercontent.com/4662568/104819407-3d1bb080-5868-11eb-95fb-7bc4c5f72469.gif)

### Code sections

The R language server informs VSCode of code sections, or blocks of code that
form coherent R expressions, which can be navigated through the outline or the
panel header.

![Code section symbols](https://user-images.githubusercontent.com/4662568/72678086-90381780-3add-11ea-9e93-0d7a4d1c1882.png)

Sections can also be folded, allowing users to organize the current editor:

![Code section and function folding ranges](https://user-images.githubusercontent.com/4662568/86252664-135dad80-bbe6-11ea-8f89-55a81f2cc898.gif)

### Call hierarchy

The R language server's static analysis also allows users to see the call
sequence and hierarchy within an R expression.

![Call Hierarchy](https://user-images.githubusercontent.com/4662568/106375983-e49df480-63cb-11eb-80ef-b1967a897b15.gif)

---

## Document navigation

---

### Document and workspace symbols

Users can navigate through the document outline or search for symbols by
prepending an `@` symbol in the search bar.

![Document/workspace symbols](https://user-images.githubusercontent.com/4662568/86803613-bc098280-c0a8-11ea-9ca5-4732172cd835.gif)

### Find all occurrences

`Ctrl+Click`ing on a user-created R object, pressing `Shift+F12` while the
cursor is focused on any object, or right-clicking and then selecting
`Go To References` will open a popup showing all of the uses of the object
within the current document.

![Find references](https://user-images.githubusercontent.com/4662568/93667495-fb951780-fab8-11ea-96bf-8649b89a85d7.gif)

### Document links

`Ctrl+Click` on a file path takes the user to the referenced document.

![Link](https://user-images.githubusercontent.com/4662568/73524149-7e446600-4447-11ea-84a8-9fe152df7562.png)

### Go to definition

`Ctrl+Click`ing on an R symbol, pressing `F12` while the cursor is focused on a
symbol, or right-clicking and then selecting `Go To Definition` will bring up a
function's implementation.

![Definition](https://user-images.githubusercontent.com/4662568/71432970-704c4880-2717-11ea-9fc0-7f7ced962874.gif)

---

## Miscellaneous

---

### Color picker

Strings of text that are recognized as R colors are rendered with a color
decoration. Hovering over the decoration brings out a color picker popup that
can be used to adjust the referenced color.

![Document color](https://user-images.githubusercontent.com/4662568/73992222-5f832980-4989-11ea-9593-a58e97df47b5.png)
