# Working with renv-enabled projects

[renv](https://rstudio.github.io/renv/articles/renv.html) is a package that helps manage library paths to help isolate your project’s R dependencies for better reproducibility of the project.

Since `renv` uses a private library per project, vscode-R features will not work
if their required R packages are unavailable in the active project library.
There are two general approaches to this problem.

### Option 1: Declare explicit vscode-R dependencies

Within each of your `renv` enabled projects, consider adding a simple `scaffolding.R` (or whatever you want to call it) file that explicitly declares your vscode-R dependencies. In most cases, all you would need is:

```r
library(languageserver)
library(jgd)            # optional
library(httpgd)         # optional
library(vscDebugger)    # optional
```

Do not add `library(sess)` to this scaffolding file. vscode-R ships and manages
the matching `sess` version itself. In a managed terminal it prompts before
installing or updating `sess` in the active library. When attaching an existing
external R session, the generated attach script installs or updates the bundled
version when needed without a separate prompt.

Note that you don't actually have to ever call this `scaffolding.R` file as part of your workflow. But by naming these packages explicitly in a project script, you ensure that `renv` will configure your project dependencies correctly. Moreover, this ensures that they will be added to `renv`'s [global cache](https://rstudio.github.io/renv/articles/package-install.html#cache), which reduces re-installation overhead across your other VS Code + `renv` projects.


### Option 2: Link a standalone library

_Note: Some users have reported that this approach no longer works. See discussion in [this thread](https://github.com/rstudio/renv/issues/1129#issuecomment-2248960686)._

Some users might find it useful to maintain a standalone, minimal user library to provide these packages.

Suppose we want to maintain such a library at `~/R/vscode-R` using renv.

```r
renv::init(project = "~/R/vscode-R")
```

Start R from the folder (`path.expand("~/R/vscode-R")`) and install required packages:

```r
renv::install(c("languageserver"))
```

Print the library path:

```r
renv::paths$library()
```

```
[1] "/Users/user/R/vscode-R/renv/library/R-4.2/x86_64-apple-darwin17.0"
```

Write the library path in VS Code settings:

```json
"r.libPaths": [
  "/Users/user/R/vscode-R/renv/library/R-4.2/x86_64-apple-darwin17.0"
]
```

Then the following R processes running in the background will be launched with the configured library paths appended to `.libPaths()` on startup:

* R language server
* R help server
* R aliases

And the code editing features and help viewer could continue to work without necessary packages being installed into the project library.

---

When working with `Rcpp`, a good demo is provided at [vscode-rcpp-demo](https://github.com/renkun-ken/vscode-rcpp-demo). If you're working with `renv`, the `includePath` property in `.vscode/c_cpp_properties.json` needs to manually be pointed at your project's `R_LIBS_USER` directory. Exempli gratia: 

```
/Users/user/Library/Caches/org.R-project.R/R/renv/library/vscode-rcpp-demo-e5908179/macos/R-4.4/aarch64-apple-darwin20
# becomes
/Users/user/Library/Caches/org.R-project.R/R/renv/library/vscode-rcpp-demo-e5908179/macos/R-4.4/aarch64-apple-darwin20/*/include/
```
