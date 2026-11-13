# Code linting

R code linting (diagnostics) is provided by [lintr](https://github.com/r-lib/lintr) via language server and is enabled by default. It provides syntax error warnings as well as style guidelines.

To disable diagnostics, you might add the following to the VS Code settings:

```json
{
  "r.lsp.diagnostics": false
}
```

However, you will not be notified if syntax errors in the code are detected.

## Customize

The [default](https://lintr.r-lib.org/articles/lintr.html#defaults) linting behaviour is based on the `tidyverse` style guide, which you may not find to your liking. To customize, you should create/edit the global lintr config file at `~/.lintr`. Alternatively, you can also create/edit a project-specific lintr config file at `${workspaceFolder}/.lintr`. Some example of customized lintr files are provided below.

- Visit [Individual linters](https://lintr.r-lib.org/reference/index.html#individual-linters) for a complete list of supported linters.
- Visit the [Configuring linters](https://lintr.r-lib.org/articles/lintr.html#configuring-linters) for a complete guide to customizing lintr config regarding the list of linters and file or line exclusions.

### Examples

#### Only detect syntax errors:

```
linters: list()
```

#### Deviate from [default linters](https://lintr.r-lib.org/reference/default_linters.html):

Here's an example of a simple `~/.lintr` override, where we turn off the `<-` assignment linter (i.e., `=` is fine) and adjust the number of characters in each line.

```
linters: linters_with_defaults(
   assignment_linter = NULL,
   line_length_linter(120)
  )
```

(Note: the leading space in front of the final parenthesis is deliberate, since it is required for the DCF format.)

Here's a more aggressive example, where we override multiple defaults. Background [here](https://github.com/REditorSupport/vscode-R/issues/1400).

```
linters: linters_with_defaults(
   assignment_linter     = NULL, # allow `=` for assignment
   commented_code_linter = NULL, # allow commented-out code
   line_length_linter    = NULL, # lintr default is 80 chars
   object_name_linter    = NULL, # allow any naming style (e.g., camelCase)
   object_usage_linter   = NULL, # skip checks for undefined/unused variables
   quotes_linter         = NULL, # allow single quotes
   semicolon_linter      = NULL, # allow semicolons
   whitespace_linter     = NULL  # allow tabs for indentation
  )
```

#### Only use specified linters:

```
linters: list(
  commas_linter(),
  duplicate_argument_linter(),
  missing_argument_linter(),
  missing_package_linter(),
  namespace_linter())
```
