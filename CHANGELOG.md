# Change Log

## Latest updates

You can check all of our changes from [Release Page](https://github.com/REditorSupport/vscode-R/releases)

## [2.8.3](https://github.com/REditorSupport/vscode-R/releases/tag/v2.8.3)

Enhancements:

* Substitute variables in `r.rpath` and `r.rterm` settings. (#1444)
* Improve code chunk handling in base .R files. (#1454, thanks @kylebutts)

Fixes:

* Fix multiline smart-knit (#1493)
* Fix RMD Progress Bar (#1491)
* Remove `.` as an R language `editor.wordSeparators` (#1503, thanks @opasche)
* `numeric_version()` wants character as of R 4.4 (#1520, #1523, thanks @jennybc and @pawelru)
* Handle terminals created by vscode-Python (#1511, thanks @tomasnobrega)

## [2.8.2](https://github.com/REditorSupport/vscode-R/releases/tag/v2.8.2)

Enhancements:

* Update built-in function match regex. (#1431, thanks @MichaelChirico)
* Add `r.useRenvLibPath` setting to opt in adding `renv` package cache to `.libPaths` when R processes (language server, help server, etc.) start up. (#1423, thanks @nateybear)
* Add a VScode task to run `testthat::test_file()`` on the currently open file. (#1415, thanks @gowerc)
* `r.rterm.*` settings now accept paths relative to the current workspace folder to support customized commands
to create R terminals. (#1398, thanks @Tal500)
* Upgrade ag-grid-community to v30.2.0 (#1434)
* Upgrade vscode-languageclient to v9.0.1 (#1435)

## [2.8.1](https://github.com/REditorSupport/vscode-R/releases/tag/v2.8.1)

Enhancements:

* A new setting `r.lsp.multiServer` is added. If disabled, only a single language server will be spawned from the first workspace folder to handle all requests from all workspaces and files. (#1375)
* Upgrade ag-grid-community to v30.0.0 (#1379)

Fixes:

* Fix handling `r.session.data.pageSize = 0`. (#1364)
* Fix help panel in remote host. (#1374)
* Fix missing package names in "Install CRAN Package". (#1377)

## [2.8.0](https://github.com/REditorSupport/vscode-R/releases/tag/v2.8.0)

New Features:

* A new experimental setting `r.session.useWebServer` is added to support communicating with R session via a web server running in R. This requires R package `httpuv` to be installed. Currently,
it enhances the session symbol completion when accessing R object via `$` and `@`. *This feature is
experimental and may be subject to change in the future.* (#1151)
* A new setting `r.rmarkdown.preview.zoom` is added to support the default zoom level or R markdown
preview. (#1333)

Enhancements:

* Improve message when error occurs on loading R packages. (#1334, thanks to @csaybar)
* Upgrade ag-grid-community to v29.3.0 (#1346)

Fixes:

* Commands that are not intended in the command pallete are now hidden. (#1327, #1330)

## [2.7.2](https://github.com/REditorSupport/vscode-R/releases/tag/v2.7.2)

Enhancements:

* Upgrade vscode-languageclient to 8.1.0 (#1315)
* Workspace viewer will be cleaned-up when the attached R session exits. (#1318, #1321)
* A new command `r.view` is added to view selected objects. (#1319, thanks @yeyun1999)
* Workspace viewer commands that require an attached R session are now disabled when no R session is attached. (#1323)

Fixes:

* Workspace viewer now has a fallback message instead of causing error if session watcher is disabled. (#1317)

## [2.7.1](https://github.com/REditorSupport/vscode-R/releases/tag/v2.7.1)

New Features:

* A new setting `r.source.echo` is added to support sending `source(file, echo = TRUE)` by default. (#1286, thanks @jakub-jedrusiak)
* A new setting `r.removeLeadingComments` is added to remove leading comments when sending code to terminal. (#1245, thanks @gowerc)

Enhancements:

* Help page previews from `.Rd` files are now generated asynchronously. (#1273)
* Column name is also displayed in the column tooltip in a data viewer. (#1278, thanks @eitsupi)
* Upgrade ag-grid-community to v29.0.0 (#1290)

Fixes:

* Fixed broken tests (#1302)

## [2.7.0](https://github.com/REditorSupport/vscode-R/releases/tag/v2.7.0)

New Features:

* New syntax highlighting support for `NAMESPACE` and `.Rbuildignore`. (#1221, thanks @nx10)
* Support help preview in package development. (#1259, #1266)

Enhancements:

* The extension is re-published to [Open VSX Registry](https://open-vsx.org/extension/reditorsupport/r). ([open-vsx#591](https://github.com/open-vsx/publish-extensions/issues/591)).
* The WebView panel now supports htmlwidgets using Web Workers. (#1261, thanks @anthonynorth)
* Code block detection now includes parentheses, which is more consistent with RStudio behavior. (#1269)

Fixes:

* `View()` no longer stops with `tibble()` that contains objects that do not
implement `asJSON()` method. (#1255)
* Fixed the regex for detecting problems reported by testthat from tasks. (#1257, thans @gowerc)
* Fixed syntax highlighting in help preview under R 4.2.x. (#1268)

## [2.6.1](https://github.com/REditorSupport/vscode-R/releases/tag/v2.6.1)

Enhancements:

* A new setting `r.plot.devArgs` is added to allow customizing png device arguments (e.g. width and height) for the PNG plot viewer. (#1235)

Fixes:

* Fixed opening requested file externally when viewer is disabled. (#1209)
* Support trailing slash in code-server's URI template. (#1241)

## [2.6.0](https://github.com/REditorSupport/vscode-R/releases/tag/v2.6.0)

New Features:

* A new command "R: Generate C/C++ Configuration" is added to support auto-generating [`c_cpp_properties.json`](https://code.visualstudio.com/docs/cpp/customize-default-settings-cpp) in an R package with C/C++ code for [C/C++](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) Extension to provide IntelliSense. (#1205, thanks @nx10)

Enhancements:

* Support showing KeTeX formula in help viewer. (#1213)

Fixes:

* Fixed empty line at the end of help pages as clickable example. (#1194)
* Avoid code highlighting in DESCRIPTION files in help viewer as code examples. (#1199)
* Saving a rmd file no longer triggers the preview to refresh if it is still rendering. (#1219)

## [2.5.3](https://github.com/REditorSupport/vscode-R/releases/tag/v2.5.3)

Enhancements:

* Reload help pages on refresh. (#1188)
* Upgrade to vscode-languageclient 8.0.2. (#1173)

Fixes:

* Remove `encoding` from knitting so that renderers that do not have an encoding parameter (e.g. `quarto::quarto_render()`) now work properly. (#1167)

## [2.5.2](https://github.com/REditorSupport/vscode-R/releases/tag/v2.5.2)

New Features:

* R help viewer now highlights code sections on hover and user can click the code to copy it to the clipboard, or press `ctrl+click` (Windows and Linux) or `cmd+click` (macOS) to send it to R terminal by default. A new setting `r.helpPanel.clickCodeExamples` is added to allow customizing the click behavior. (#1138)
* A new command `Create .lintr` is added. (#1112)

Enhancements:

* R and Rmd files are added to `Create: New File`. (#1119)
* Improved data viewer column resizing. (#1121)

Fixes:

* Hide environment values in R Markdown preview to prevent accidental deletion (#1117)
* Opening and closing a list item in the workspace viewer treeview now works properly. (#1150)

## [2.5.0](https://github.com/REditorSupport/vscode-R/releases/tag/v2.5.0)

Announcement:

* [vscode-R](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) has been transferred to `REditorSupport` as the publisher in the VS Code Marketplace. The unique identifier has been updated to `REditorSupport.r`. (#690)
* [R in Visual Studio Code](https://code.visualstudio.com/docs/languages/r) topic is added to the VS Code documentation.

New Features:

* A new setting `r.libPaths` is added to support additional library paths to be appended to `.libPaths()` when R background processes (R language server and help server) are launched. It could be useful for projects with [renv](https://rstudio.github.io/renv/articles/renv.html) enabled where required packages (e.g. `languageserver` and `jsonlite`) to use vscode-R are only installed in other location. For more details, checkout the [wiki](https://github.com/REditorSupport/vscode-R/wiki/Working-with-renv-enabled-projects). (#1071, #1097, #1098)

Enhancements:

* The R package build task is separated into Build and Build Binary tasks. (#1029, thanks @Yunuuuu)
* Hide smart knit environment variables to prevent accidental deletion. (#1060)
* A new setting `r.session.data.pageSize` is added to support adjusting the page size of the data viewer. The default is now 500. (#1068)
* The check for languageserver package installation is improved and the prompt could be disabled. (#1071)
* The R Markdown code chunk snippet supports language choice. (#1082, thanks @jooyoungseo)
* It will prompt instead of showing empty choice when no R Markdown templates are found. (#1089)

Fixes:

* Guard against evaluation of active bindings in the global environment. (#1038)
* The `http` prefix is unnecessary and removed from several code snippets. (#1084, #1085, thanks @jooyoungseo)
* R Markdown knit and preview scripts now use `loadNamespace()` instead of `requireNamespace()` to fail early if necessary packages are unavailable. (#1086)

## [2.4.0](https://github.com/REditorSupport/vscode-R/releases/tag/v2.4.0)

New Features:

* Added "R Markdown: New Draft" command to choose a template for a new R Markdown document. (#984)
* Added *Attached Namespaces* and *Loaded Namespaces* to the workspace viewer. (#1022)

Enhancements:

* `spawn` is consistently used to run R scripts and commands. (#985)
* Added a problemMatcher for testthat output from Test task. (#989, thanks @gowerc)
* Code chunk snippets now preserve selected text. (#1001)
* Added more useful Shiny and R Markdown snippets. (#1009, #1012, thanks @jooyoungseo).
* Provides optional `code` argument to `r.runSelection` command for other extensions to execute interactive R code. (#1017, thanks @jjallaire)
* Supports lambda function declaration in syntax higlighting. (#1025)

Fixes:

* Fixed code detection with mixed quotes. (#988, thanks @gowerc)
* Fixed syntax highlighting for variables starting with `function`. (#992, thanks @gowerc)
* Fixed R task definition and `resolveTask`. (#994)
* Fixed auto port forwarding for httpgd plot viewer in LiveShare session. (#1026)

## [2.3.8](https://github.com/REditorSupport/vscode-R/releases/tag/v2.3.8)

Fixes:

* Fixes languageserver detection failure on Windows by avoiding rpath quoting. (#981)

## [2.3.7](https://github.com/REditorSupport/vscode-R/releases/tag/v2.3.7)

Note:

* After v2.3.4, httpgd plot viewer requires `httpgd` 1.2.0 or later. If the plot viewer shows 404 error, installing the latest release of `httpgd` should resolve the problem. (#972)

Enhancements:

* Data viewer supports [Apache Arrow Table](https://arrow.apache.org/docs/r) and `r.session.data.rowLimit` setting is added to limit the number of rows to show. (#945, thanks @eitsupi)
* R gitignore file is updated and "R: Create gitignore" also supports multi-root workspace. (#949, thanks @eitsupi).
* Httpgd plot viewer has a delay before refreshing to avoid redrawing too often. (#956)
* Shell commands used in tasks use strong quoting. (#964, thanks @shrektan)
* User will be prompted to install `languageserver` if the package is missing. (#965, @shrektan)
* DCF syntax is updated to support syntax highlighting of `.lintr`. (#970, thanks @eitsupi)
* Column headers show the class and type of each column in tooltips. (#974, thanks @eitsupi)
* Extension is activated if the workspace folder contains `*.{rproj,Rproj,r,R,rd,Rd,rmd,Rmd}` at any level of sub-folders. (#979)

Fixes:

* Fix typo in command line arguments. (#954, thanks @achey2016)
* R Markdown commenting uses HTML-style comments outside code blocks. (#958)
* R Markdown rendering process gets `LANG` environment variable to properly handle unicode characters. (#961, thanks @shrektan)

## [2.3.6](https://github.com/REditorSupport/vscode-R/releases/tag/v2.3.6)

Enhancements:

* Added raw string syntax. (#922)
* Added support for both single and double brackets in code-server's URI template. (#934, thanks @benz0li)

Fixes:

* Fixed syntax highlighting so that variables and function parameters are highlighted more consistently. (#939)
* R processes are now properly terminated on extension deactivation. (#941, thanks @albertosantini and @Yunuuuu)

## [2.3.5](https://github.com/REditorSupport/vscode-R/releases/tag/v2.3.5)

Enhancements:

* Added `devtools` tasks to command palette. (#880, thanks @alex-gable)
* Improved help pages readability. (#915, thanks @18kimn)

Fixes:

* Fixed R Markdown knit and preview without opening a workspace folder. (#914)
* Fixed `DESCRIPTION` syntax highlighting for `Authors@R` field. (#920)
* Fixed an issue about leaking child processes. All spawned child processes (e.g. help server, language server, R Markdown preview) are cleaned up on exit. (#918)

## [2.3.4](https://github.com/REditorSupport/vscode-R/releases/tag/v2.3.4)

Enhancements:

* Quotes in `r.rpath.*` settings are now removed. (#884)
* Alternative CRAN mirrors (e.g. [RStudio Public Package Manager](https://packagemanager.rstudio.com) and [the ropensci universe](https://ropensci.r-universe.dev) are supported. (#876)

Fixes:

* Fixed a Uri handling bug in Windows. (#888)
* Fixed a bug in restarting help server when library has changed. (#893)

## [2.3.3](https://github.com/REditorSupport/vscode-R/releases/tag/v2.3.3)

Enhancements:

* The information of attached R session now appears in the label and the tooltip of
the status bar item. (#836)
* A new setting `r.rmarkdown.knit.command` is added to support customized knit command if not specified in the document. (#841, #850, thanks @xoolive)
* A terminal profile for R is added via the new terminal API. (#851)
* The help topics are now automatically updated when R packages are installed, removed, or upgraded. (#863)

Fixes:

* Fixed the problem with PowerShell on Windows when installing packages. (#846)
* Fixed the handling of single quote in roxygen comments and the roxygen block is now automatically exited after two empty lines. (#847)
* Backtick is added to the list of quote characters for syntax highlighting. (#859, thanks @jan-imbi)
* Fixed detecting the YAML frontmatter in R Markdown documents. (#856)
* Fixed attaching an R session with an open httpgd device that also triggers the plot viewer. (#852)
* Fixed the chunk coloring in R Markdown preview. (#867)
* Fixed the delimiter used in the output of the background knit process. (#868)

## [2.3.2](https://github.com/REditorSupport/vscode-R/releases/tag/v2.3.2)

Enhancements:

* `.vsc.browser()` now handles `file://` urls. (#817)
* `r.session.levelOfObjectDetail` gains a `Normal` value for the session watcher to write only first level structure of global objects for performance. (#815)
* Session watcher now supports workspace folder as symlinks. (#827)

Fixes:

* Httpgd plot viewer respects the view column specified by `r.session.viewers.viewColumn.plot` setting (#816)
* `View` is completed replaced so that `tibble::view()` could
trigger data viewer (#818)
* Help cache is disabled between sessions (#819)

## [2.3.1](https://github.com/REditorSupport/vscode-R/releases/tag/v2.3.1)

Enhancements:

* Proxied requests are now supported to work with [code-server](https://github.com/cdr/code-server). (#275, #803)

Fixes:

* `unsafe-eval` is re-enabled in WebView Content Security Policy to make htmlwidgets such as plotly work. (#805)
* The help viewer now respects `r.session.viewers.viewColumn.helpPanel`. (#804)
* The working directory of the knit background process is now consistent with the knit working directory so that `.Rprofile` and `renv` setup are respected. (#807)

## [2.3.0](https://github.com/REditorSupport/vscode-R/releases/tag/v2.3.0)

Enhancements

* R Markdown preview now supports background rendering with progress bar, customizable
  working directory, and smart knit button. (#765)
* `{rstudioapi}` emulation is enabled by default. (#769)
* A new setting `r.session.objectLengthLimit` is added to limit the output of the names of global objects with many named elements which might cause significant delay after inputs. (#778)
* `NA` and `Inf` could now be correctly displayed in the data viewer. (#780)
* User-specified R Markdown output format is now respected. (#785)

Fixes

* The security policy of WebView is relaxed to support `{flextable}` widgets. (#771)
* The R Markdown background rendering process could be properly terminated now. (#773)

## [2.2.0](https://github.com/REditorSupport/vscode-R/releases/tag/v2.2.0)

New Features

* VS Code settings are now accessible from R and all vscode-specifc R options (`vsc.*`) now have
corresponding VS Code settings. (#743)

Enhancements

* Check conflict extension `mikhail-arkhipov.r` on activation. (#733)
* Add icons to WebViews. (#759)

Fixes

* Fix date filter in data viewer. (#736)
* Fix htmlwidget resource path in WebView. (#739)
* Use `.DollarNames` with default pattern. (#750)
* Fix syntax highlighting for `c()` in function args. (#751)
* Handle error in `capture_str()`. (#756)

## [2.1.0](https://github.com/REditorSupport/vscode-R/releases/tag/v2.1.0)

Important changes

* The project is migrated to [REditorSupport](https://github.com/REditorSupport) organization on
GitHub. (#98)
* The R language service (completion, document outline, definition, etc.,
formerly implemented in [vscode-r-lsp](https://github.com/REditorSupport/vscode-r-lsp)) is now
integrated into vscode-R (#695). The vscode-r-lsp extension will be unpublished from the
VS Code marketplace
at some point.
  * Search `r-lsp` extension, uninstall it and vscode-R will start the R langauge service
  automatically.
  * The language service still depends on the R package [`languageserver`](https://github.com/REditorSupport/languageserver). Make sure the package is installed before using vscode-R.
  * To opt-out the language service, set `"r.lsp.enabled": false` in your user settings.
* R session watcher is now enabled by default. (#670)
  * `r.previewDataframe` and `r.previewEnvironment` will use the session watcher if enabled.
  * To opt-out, set `"r.sessionWatcher": false` in your user settings.

New Features

* Preview R Markdown documents via background process with auto-refresh and dark theme support. (#692, #699)

Enhancements

* Several enhancements of the workspace viewer. (#672)
* The plot viewer now supports customizable CSS file via `r.plot.customStyleOverwrites` and
 `r.plot.togglePreviewPlots` now cycles through mutlirow/scroll/hidden. (#678, #681)
* The data viewer is now based on [ag-grid](https://github.com/ag-grid/ag-grid) with better performance and better support for filtering and dark theme. (#708)
  * The data viewer might not work with existing R sessions started before the extension update.
  A restart of sessions is needed to use the new data viewer.
* Command `r.showPlotHistory` is removed in favor of the httpgd-based plot viewer. (#706)
* The plot viewer now supports full window mode. (#709)

Fixes

* LiveShare API bug fix and enhancements. (#679)
* Fix syntax highlighting of integers in scientific notation. (#683)

## [2.0.0](https://github.com/REditorSupport/vscode-R/releases/tag/v2.0.0)

Highlight

* Thank you for join new collaborator: Elian H. Thiele-Evans(@ElianHugh)
  * LiveShare Functionality #626
    * More detail about LiveShare: <https://code.visualstudio.com/learn/collaboration/live-share>
  * rmarkdown bug squashing and minor changes #663
  * Code cells in .R files #662

* Use .DollarNames for object with class in completion #660

## [1.6.7](https://github.com/REditorSupport/vscode-R/releases/tag/v1.6.7)

* Update R syntax #647
* Fix replacing base::.External.graphics #625

Thank you for your contributions.

* @jolars
  * Don't run chunks with eval = FALSE #653 (Fix #651)
* @nx10
  * Integrate httpgd #620

## [1.6.6](https://github.com/REditorSupport/vscode-R/releases/tag/v1.6.6)

Highlight

* Clarify error messages
* Being more conservative to call object.size() in task callback
* Send code to debug repl
* shim the rstudioapi if it has already been loaded

Thank you for your contributions.

* @krlmlr
  * Update vscode engine #586
  * Satisfy markdownlint #587
* @danielbasso
  * Initial Workspace Viewer str() functionality #583

## 1.6.5

* Add links to help pages in hover #578
* Move `r.runSource` and `r.knitRmd` to `editor/title/run` #573 (Fix #572)
* Fix so code can be run after creating terminal #567
* Add option to keep terminal hidden after running code #566
* Scroll to bottom after running a command #559 (Thank you @samkimhis)
* Refactoring and implementation of webviewPanelSerializer #556
* add option vsc.hover.str.max.level #545
* Change workspace tooltip #544 (Thank you @ElianHugh)

## 1.6.4

* Better error message when reading aliases (#518)
* Keep promises and active bindings in globalenv (#521)
* Refactor extension.ts (#525)
* Write aliases to file (#526)
* add sendToConsole to rstudioapi emulation (#535)
* Add function to open help for selected text (#531)
* Add initial pipeline completion support (#530)
* Add updatePackage command (#532)
* Add option to preserve focus when opening help view (#541)

## 1.6.3

* Add browser WebView command buttons #494
* Enable find widget in WebViews #490
* Disable alwaysShow for addin items #491
* Only show R menu items in R view #493
* Modify pre-release action #492 (Fix #484)
* Improve release action #505 (Fix #503)
* Improve help view #502 (Follow up to #497)

### Thank you for contributors works 1.6.3

* @ElianHugh
  * Implement R workspace viewer #476 (Fix #416)
  * Conditionally show view #487
* @tdeenes: Find in topic (help panel) #488 (Fix #463)
* @jsta: typo fix #500

## 1.6.2

* Improve style of help pages #481
  * All help pages: center headings
  * Normal functino help pages: hide (rather useless) header bar
  * All help pages: hide image placeholders
  * Manuel Pages: hide page-internal links
  * Manual Pages: suppress mismatching header styles embedded in the html
* Reorganize helppanel, add `?` function #477
* Modify config #467
* Fix bug that would leave background R processes running #475

* Fix whole of style (Extends #361) (#474)

### Thank you for contributors works 1.6.2

* @markbaas: Fix The Ctrl+Enter shortcut does not work properly when a non-comment line in a function definition contains the "#" character. #462 (Fix #443)  
* @kar9222:
  * Update README #480 (Fix #465)
  * RMarkdown: Add run & navigation commands. More customization. Refactor. #465

## 1.6.1

This version includes minor fix to stable new functions

* Add GitHub Action for release #449
* Highlight all chunks #453
* Fix checking workspaceFolders in rHelpProviderOptions #456
* Fix typo in help panel path config #457

* @kar9222 Thank you for contribution
  * Update README: Add options(vsc.helpPanel = ...) #461
  * Rmd fenced block syntax highlighting for julia, python, etc #460

* New feature r.runFromLineToEnd #448 (Thank you @Dave-cruzz)

## 1.6.0

* Integrate help view from vscode-R-help #433 (Implemented by the new collabolator @ManuelHentschel)
* Add terminal information to chooseTerminal error #447
* Send code at EOF appends new line #444
* Friendly error message when trying to launch addin picker and vsc.rstudioapi = FALSE #441
* platform independent content string splitting #436
* Add runAboveChunks command #434

## 1.5.2

* Enhance R markdown support #429 (Fix #428, #49, #261)
* Fix and enhance navigateToFile #430
* Improve handling html help #427 (Fix #426, #380)

## 1.5.1

* Rename init functions #425 (Fix #424)
* Fix issues in rstudioapi emulation #422 (Fix #421)

## 1.5.0

* RStudio Addin Support #408 (Implemented by the new collabolator @MilesMcBain)
  * The usage is added on the [wiki page](https://github.com/REditorSupport/vscode-R/wiki/RStudio-addin-support)

* Recommend radian in README #420

## 1.4.6

* Remove Run in Active Terminal from README #413 (Fix #412)
* Remove command Run Selection/Line in Active Terminal #409 (Fix #306)
* Check url in browser #406 (Fix #371)

## 1.4.5

* Remove shortcuts Ctrl + 1, 2, 3, 4, 5 #401 (Fix #368)

    These conflicted with default Visual Studio Code keyboard shortcuts. If you would like to restore them, see the [instructions in the Wiki](https://github.com/REditorSupport/vscode-R/wiki/Keyboard-shortcuts#removed-keyboard-shortcuts).

* Restore R_PROFILE_USER #392 (Fix #391)
* Fix so rTerm is undefined when deleting terminal #403 (Fix #402)

## 1.4.4

* Fix vulnerability issues

## 1.4.2

* New R options and functions to control session watcher behavior #359

    To work with existing self-managed, persistent R sessions as the extension is upgraded,
    source the `init.R` again before attaching.

    ```r
    source(file.path(Sys.getenv(if (.Platform$OS.type == "windows") "USERPROFILE" else "HOME"), ".vscode-R", "init.R"))
    ```

* Remove single quote from doesLineEndInOperator #357 (Fix #356)

## 1.4.1

* Fix View empty environment #350 (Fix #349)
* Change runSelectionInActiveTerm effect to warning #351
* Improve getBrowserHtml #353
* Use fs.watch instead of vscode.FileSystemWatcher #348 (Fix #347, #352, #236, #179, #272, #330)

## 1.4.0

### Feature improvement

* Add syntax highlight for DESCRIPTION and .Rproj #342 (Thank you @qinwf)
* A lot of works (Thank you @gowerc)
  * Enable default R location to be used on mac/linux if none is supplied #340
  * Added functionality to switch to an existing R terminal #338
  * Expose send text delay as a parameter #336
  * Supress auto-opening quote in roxygen comment #328
* Add r.runSelectionRetainCursor #325

### Project engineering

* Convert language files to Json #333 (Thank you @gowerc)
* Define lint in package.json and use it in GitHub Actions #344

## 1.3.0

* Change so setting changes take effect immediately (Fix #301)
* Fix package volunerability
* Improve .Rprofile
* Remove --no-site-file from default r.rterm.option

## 1.2.8

* Use eslint in GitHub Actions
* Add R Markdown surround and frontmatter comments (Fix #260)

## 1.2.7

* Add [new wiki page](https://github.com/REditorSupport/vscode-R/wiki) !
* Use Windows registry to find R path
* Fix handling grouped_df in dataview_table
* Use GitHub Actions for linting

## 1.2.6

* Fix showWebView

## 1.2.5

* Check untitled document and save result before running command

## 1.2.4

* Add configurable command runner functions (Thank you @MilesMCBain)
* Change .Platform$GUI to vscode on session start
* Fixed the function snippet (Fixed #230) (Thank you @stanmart)
* Add statement of languageserver features to bug report template (Fixed #210)
* Inject R Markdown features into Markdown grammar (Fixed #220, #116, #48, #36)

## 1.2.3

* Fixed the function snippet (Fixed #230) (Thank you @stanmart)
* Update activationEvents
* Add more logging to session watcher
* Avoid duplicate handling of response update
* Add syntax highlighting for R code in Rcpp comment #225

## 1.2.2

* View improvement (Thank you @renkun-ken)
  * Fix dataview_table handling single row data
  * Show WebView triggered by page_viewer in Active column
  * Fix WebView Uri replacing
  * Add row hover and select
  * Improve session watcher initialization
  * Use dev.args option when creating png device before replay
  * Show plot history

## 1.2.1

* Extend View (Thank you @renkun-ken)
* Fix session watcher init.R path on Windows (Fixed #176)

## 1.2.0

* R session watcher (Thank you @renkun-ken). Usage is written on the README.md
  * Attach Active Terminal (by command or clicking status bar item)
  * Auto attach on R session startup: if init.R is sourced in .Rprofile, starting an R session will notify vscode-R to automatically attach to it.
  * Provide hover to global symbol in attached session
  * Show plot file on the fly
  * Show WebView to present htmlwidgets and shiny apps
  * Show WebView for data.frame and list object when calling View()

## 1.1.9

* Fix bracketed paste on Windows (fix #117)
* Fix function call closing bracket highlight (Thank you @kiendang)

## 1.1.8

* Use word under cursor for previewDataframe, nrow (fix #137)
* Change license MIT -> AGPL-3.0

## 1.1.6

* Fix behaviour when workplacefolders is Undefiend (Thank you @masterhands)
* Show r.term.option value in settings UI
* Refactoring

## 1.1.5

* Replace deprecated function (Refactoring)
* Add alwaysUseActiveTerminal setting (fix #123)

## 1.1.4

* Fixed spelling, improved formatting #129 (Thank you @wleoncio)
* Automatically comment new lines in roxygen sections (fix #124)
* Fix send code for newlines on Windows (fix #114)
* Add auto-completion of roxygen tags (fix #128)
* Change cursorMove to wrappedLineFirstNonWhitespaceCharacter  (fix 126)

## v1.1.3

* RMarkdown knit support (fix #121) (Thank you @dominicwhite)

## v1.1.2

* Fix send code for newlines and Radian #114 #117

## v1.1.1

* Fix Preview Environment for variable x (fix  #111) by @andycraig
* Fix Preview Environment for multi-class objects (fix #111) by @andycraig
* Fix danger package dependency

## v1.1.0

* Fix for R markdown config
* Fix for valunerability

## v1.0.9

* Fix check for Excel Viewer extension

## v1.0.7

* Add web pack for performance by @andycraig

## v1.0.6

* Add runSelectionInActiveTerm command #104 (fix #80 #102) (Thank you @andycraig)

## v1.0.4

* Shortcuts with R functions #101
(fix #100) (Thank you @MaTo04)

## v1.0.3

* Fix Preview Dataframe command #67(fix #97) (Thank you @andycraig)

## v1.0.2

* Remove excel dependency

## v1.0.1

* Fix Dependency
* Refactoring

## v1.0.0

* Sorry, supporting this extension is ended. Please looking forward to coming new one (<https://github.com/Microsoft/RTVS/issues/1295>).

## v0.6.2

* fix wordPattern to avoid `.`
* fix run selection

## v0.6.1

* Added detection of bracket and pipe blocks #82 (fix #26) (Thank you @andycraig)
* Fix dependency

## v0.6.0

* Remove lintr function. If you want to use lintr, please install R LSP Client

## v0.5.9

* Fix for security dependencies

## v0.5.8

* Fix Run Selected has strange behavior #42 (Thank you @Ladvien)

## v0.5.7

* Disabled lintr for default setting that is already implemented by LSP
* Fix Commented lines are not ignored when determining code blocks #61 (Thank you @Ladvien)

## v0.5.6

* Fix some dependencies for perform and developments

## v0.5.5

* Add package dev commands #58 (Thank you @jacob-long)

## v0.5.4

* fix snippets
* R term name to R interactive (fix #46)
* Send code from Rmd chunk to terminal (fix #49)
* Depend R language server extension

## v0.5.3

* fix default r.rterm.option again to `["--no-save", "--no-restore", "--no-site-file"]`

## v0.5.2

* fix default r.rterm.option to `["--no-save", "--vanilla"]`

## v0.5.1

* Support code region by `#region` and `#endregion`

## v0.5.0

* Support package lint

## v0.4.9

* Add shebang support for R syntax highlight #33(Thank you @dongzhuoer)
* Added block detection and execute whole block #32(Thank you @Ladvien)
* Proposed fix for Load Chunk problems #27 #31(Thank you @Ladvien)
* Update some snippets from VS

## v0.4.8

* Fix Windows key map
* Add some snippets from VS

## v0.4.7

* Fix syntax
* Fix Readme
* Fix icon

## v0.4.6

* Added Environment Viewer command

## v0.4.5

* Fix syntax little
* Set icon dark and light
* Improve data viewer perform(Thank you @Lavien)
* Remove extra package

## v0.4.4

* Add `Run Source` icon

## v0.4.3

* Added Data viewer Command(Thank you @Lavien)

## v0.4.2

* Add Source with echo
* Fix keybind

## v0.4.1

* Add more shortcut key

## v0.4.0

* Add shortcut key
* Fix README.md

## v0.3.9

* Fix problem lintr was running other language's files

## v0.3.8

* Improve `Run Selection/Line` (Thank you @Ladvien)
  * Added cursorMove after line execution #13
  * Don't pass Rterm comments #14

## v0.3.7

* run lintr on did save automaticaly

## v0.3.6

* fix Terminal #7

## v0.3.5

* fix syntax

## v0.3.4

* add "builtin function" from RBox

## v0.3.3

* New syntax color from R Box
* fix typo(Thank you @Shians) #12

## v0.3.1

* fix Run Selection/Line only executes the first line of file when nothing was selected #9

## v0.3.0

* update lintr behavar

## v0.2.9

* fix lintr on Mac

## v0.2.8

* add command `R: Run Selection/Line`

## v0.2.7

* add setting `r.source.focus` #5

## v0.2.6

* add setting
  * `r.lintr.executable` #2
  * `r.rterm.option` #2
  * `r.source.encoding` (Thank you @ondrejpialek) #4
* save before `R:Run Source` command #5
* update snippets

## v0.2.5

* add `Run Selected` and `Run Source` command

## v0.2.4

* fix for Windows

## v0.2.3

* support lintr option cache and linters

## v0.2.2

* support lintr on Mac and Linux

## v0.2.0

* support lintr on Windows

## v0.1.4

* use new icon

## v0.1.3

* fix R term's perform

## v0.1.2

* fix packages

## v0.1.1

* Create .gitignore

## v0.0.9

* Fix Run R perform

## v0.0.8

* R Markdown Snippets as Markdown

## v0.0.7

* Support R Markdown

## v0.0.6

* R Integrated Terminal

## v0.0.5

* Rdocumentation Snippets

## v0.0.4

* R Snippets

## v0.0.3

* Support R documentation

## v0.0.1

* Initial release

## TODO

* Output Plot
* Debug
* Language Server
* Intellisense
