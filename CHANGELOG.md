# Changelog

## 2.8.8 - 2026-03-24

### Features

* feat: change default of r.lsp.multiServer to false

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.8.7...2.8.8>

## 2.8.7 - 2026-03-15

### Bug Fixes

* fix: correct r.term and r.path setting names in error message

### Features

* feat: support multi-root workspaces in single-server mode

### Other

* Allow bracketedPaste on win32 platform ([#1631](https://github.com/REditorSupport/vscode-R/issues/1631))
* feat: default to single language server for multi-root workspaces ([#1682](https://github.com/REditorSupport/vscode-R/issues/1682))

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.8.6...v2.8.7>

## 2.8.6 - 2025-05-31

### Other

* Syntax update and bump to 2.8.6 ([#1605](https://github.com/REditorSupport/vscode-R/issues/1605))
* Show sidebar icon only when extension is active ([#1579](https://github.com/REditorSupport/vscode-R/issues/1579))
* Move R and R markdown syntaxes to vscode-R-syntax ([#1606](https://github.com/REditorSupport/vscode-R/issues/1606))

### Refactor

* refactor: restructure files ([#1613](https://github.com/REditorSupport/vscode-R/issues/1613))

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.8.5...v2.8.6>

## 2.8.5 - 2025-04-10

### Other

* Don't close stale issues ([#1522](https://github.com/REditorSupport/vscode-R/issues/1522))
* Do not mark issues as stale
* Do not mark issues as stale ([#1561](https://github.com/REditorSupport/vscode-R/issues/1561))
* Rsyntax ([#1560](https://github.com/REditorSupport/vscode-R/issues/1560))
* Bump path-to-regexp from 6.2.2 to 6.3.0 ([#1563](https://github.com/REditorSupport/vscode-R/issues/1563))
* chore ([#1598](https://github.com/REditorSupport/vscode-R/issues/1598))
* Release 2.8.5 ([#1599](https://github.com/REditorSupport/vscode-R/issues/1599))

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.8.4...v2.8.5>

## 2.8.4 - 2024-05-18

### Bug Fixes

* Fix code

### Other

* Upgrade dependencies
* Upgrade dependencies
* Update package.json
* release 2.8.4

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.8.3...v2.8.4>

## 2.8.3 - 2024-05-07

### Bug Fixes

* Fix multiline smart-knit ([#1493](https://github.com/REditorSupport/vscode-R/issues/1493))
* Fix RMD Progress Bar ([#1491](https://github.com/REditorSupport/vscode-R/issues/1491))

### Other

* Substitute variables in `r.rpath` and `r.rterm` settings ([#1444](https://github.com/REditorSupport/vscode-R/issues/1444))
* Substitute variables in r.rterm.option and r.lsp.args settings
* getRLibPaths uses substituteVariables
* Improve code chunk handling in base `.R` files ([#1454](https://github.com/REditorSupport/vscode-R/issues/1454))
* Improvements to `.R` file chunks: ([#1455](https://github.com/REditorSupport/vscode-R/issues/1455))
* remove '.' as an R language editor.wordSeparators ([#1503](https://github.com/REditorSupport/vscode-R/issues/1503))
* `numeric_version()` wants character as of R 4.4 ([#1520](https://github.com/REditorSupport/vscode-R/issues/1520))
* handling terminals created by vscode-Python ([#1511](https://github.com/REditorSupport/vscode-R/issues/1511))
* `numeric_version()` with character arg ([#1523](https://github.com/REditorSupport/vscode-R/issues/1523))
* Bump ejs from 3.1.7 to 3.1.10 ([#1519](https://github.com/REditorSupport/vscode-R/issues/1519))
* Update init.R ([#1525](https://github.com/REditorSupport/vscode-R/issues/1525))
* release 2.8.3

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.8.2...v2.8.3>

## 2.8.2 - 2023-10-08

### Other

* Bump semver from 7.3.5 to 7.5.3 ([#1388](https://github.com/REditorSupport/vscode-R/issues/1388))
* Bump word-wrap from 1.2.3 to 1.2.4 ([#1395](https://github.com/REditorSupport/vscode-R/issues/1395))
* Update built-in function match regex ([#1431](https://github.com/REditorSupport/vscode-R/issues/1431))
* Add Option to Sync renv Cache ([#1423](https://github.com/REditorSupport/vscode-R/issues/1423))
* Add task to run `testthat::test_file()` on current file ([#1415](https://github.com/REditorSupport/vscode-R/issues/1415))
* Fix indentation_linter message ([#1433](https://github.com/REditorSupport/vscode-R/issues/1433))
* allow to invoke R terminal also in relative paths ([#1398](https://github.com/REditorSupport/vscode-R/issues/1398))
* Upgrade ag-grid-community to v30.2.0 ([#1434](https://github.com/REditorSupport/vscode-R/issues/1434))
* Upgrade vscode-languageclient to 9.0.1 ([#1435](https://github.com/REditorSupport/vscode-R/issues/1435))
* release 2.8.2

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.8.1...v2.8.2>

## 2.8.1 - 2023-06-09

### Bug Fixes

* Fix handling pageSize=0 ([#1364](https://github.com/REditorSupport/vscode-R/issues/1364))
* Fix help panel in remote host ([#1374](https://github.com/REditorSupport/vscode-R/issues/1374))
* Fix install package name ([#1377](https://github.com/REditorSupport/vscode-R/issues/1377))

### Other

* Add `r.lsp.multiServer` setting ([#1375](https://github.com/REditorSupport/vscode-R/issues/1375))
* Upgrade to ag-grid-community-v30.0.0 ([#1379](https://github.com/REditorSupport/vscode-R/issues/1379))
* release 2.8.1

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.8.0...v2.8.1>

## 2.8.0 - 2023-04-28

### Bug Fixes

* Fix markdown lint

### Other

* Hide most help panel commands in command palette ([#1327](https://github.com/REditorSupport/vscode-R/issues/1327))
* Hide liveshare toggle command ([#1330](https://github.com/REditorSupport/vscode-R/issues/1330))
* Bump webpack from 5.38.1 to 5.76.0 ([#1331](https://github.com/REditorSupport/vscode-R/issues/1331))
* Handle errors in `getAliases.R` ([#1334](https://github.com/REditorSupport/vscode-R/issues/1334))
* Remove unused ag-theme-balham-dark.min.css
* Upgrade to ag-grid-community-v29.3.0 ([#1346](https://github.com/REditorSupport/vscode-R/issues/1346))
* Websocket communication ([#1151](https://github.com/REditorSupport/vscode-R/issues/1151))
* RMD Preview: font-size setting ([#1333](https://github.com/REditorSupport/vscode-R/issues/1333))
* release 2.8.0
* release 2.8.0

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.7.2...v2.8.0>

## 2.7.2 - 2023-03-06

### Other

* Basic unit test for workspace viewer ([#1305](https://github.com/REditorSupport/vscode-R/issues/1305))
* Update yarn.lock
* Upgrade vscode-languageclient to 8.1.0 ([#1315](https://github.com/REditorSupport/vscode-R/issues/1315))
* Explicit workspace behaviour ([#1317](https://github.com/REditorSupport/vscode-R/issues/1317))
* Ensure workspace is cleared ([#1318](https://github.com/REditorSupport/vscode-R/issues/1318))
* Added r.view command: View(variable) ([#1319](https://github.com/REditorSupport/vscode-R/issues/1319))
* Always check pid before clearing workspace ([#1321](https://github.com/REditorSupport/vscode-R/issues/1321))
* Workspace viewer command visibility ([#1323](https://github.com/REditorSupport/vscode-R/issues/1323))
* release 2.7.2

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.7.1...v2.7.2>

## 2.7.1 - 2023-02-15

### Bug Fixes

* Fix broken tests ([#1302](https://github.com/REditorSupport/vscode-R/issues/1302))

### Other

* Bump minimatch from 3.0.4 to 3.1.2 ([#1271](https://github.com/REditorSupport/vscode-R/issues/1271))
* Make help preview async ([#1273](https://github.com/REditorSupport/vscode-R/issues/1273))
* Add the column name to the tooltip on data viewer ([#1278](https://github.com/REditorSupport/vscode-R/issues/1278))
* Ability to set echo=TRUE in Run source by default ([#1286](https://github.com/REditorSupport/vscode-R/issues/1286))
* Remove leading comments from terminal submission (#1244) ([#1245](https://github.com/REditorSupport/vscode-R/issues/1245))
* Upgrade ag-grid-community to v29.0.0 ([#1290](https://github.com/REditorSupport/vscode-R/issues/1290))
* Migrate to @vscode/test-electron ([#1303](https://github.com/REditorSupport/vscode-R/issues/1303))
* release 2.7.1

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.7.0...v2.7.1>

## 2.7.0 - 2022-12-04

### Bug Fixes

* fix typo in dialog ([#1249](https://github.com/REditorSupport/vscode-R/issues/1249))

### Other

* Enable publishToOpenVSX
* Add Open VSX Registry installation option to README ([#1102](https://github.com/REditorSupport/vscode-R/issues/1102))
* Use `force=TRUE` when viewing data.frame and list ([#1255](https://github.com/REditorSupport/vscode-R/issues/1255))
* fixed broken tasks problemMatcher regex ([#1257](https://github.com/REditorSupport/vscode-R/issues/1257))
* Fix webview: Add webview csp directives for web workers ([#1261](https://github.com/REditorSupport/vscode-R/issues/1261))
* Add language support for NAMESPACE & .Rbuildignore ([#1221](https://github.com/REditorSupport/vscode-R/issues/1221))
* Implement help preview for local package(s) ([#1259](https://github.com/REditorSupport/vscode-R/issues/1259))
* Encoding fix
* Respect RdMacros ([#1266](https://github.com/REditorSupport/vscode-R/issues/1266))
* Change code block detection to include parentheses ([#1269](https://github.com/REditorSupport/vscode-R/issues/1269))
* Remove script tags in R v4.2.x help pages ([#1268](https://github.com/REditorSupport/vscode-R/issues/1268))
* release 2.7.0

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.6.1...v2.7.0>

## 2.6.1 - 2022-10-31

### Bug Fixes

* Fix checking `request.viewer` ([#1234](https://github.com/REditorSupport/vscode-R/issues/1234))

### Other

* Tweak settings ([#1235](https://github.com/REditorSupport/vscode-R/issues/1235))
* Support trailing slash in code-server's URI template ([#1241](https://github.com/REditorSupport/vscode-R/issues/1241))
* release 2.6.1

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.6.0...v2.6.1>

## 2.6.0 - 2022-10-11

### Bug Fixes

* Fix empty code examples ([#1194](https://github.com/REditorSupport/vscode-R/issues/1194))
* Fix help
* Fix help katex support under remote development ([#1217](https://github.com/REditorSupport/vscode-R/issues/1217))
* Fix use of asExternalUri

### Other

* Avoid code highlighting in DESCRIPTION files ([#1199](https://github.com/REditorSupport/vscode-R/issues/1199))
* Avoid .R file lock on windows ([#1192](https://github.com/REditorSupport/vscode-R/issues/1192))
* devTasks ([#1200](https://github.com/REditorSupport/vscode-R/issues/1200))
* Add generated .js files to .gitignore
* Bug report template: Minor spelling and formatting adjustments ([#1206](https://github.com/REditorSupport/vscode-R/issues/1206))
* Implement c_cpp_properties.json file generator fixes #1201 ([#1205](https://github.com/REditorSupport/vscode-R/issues/1205), [#1201](https://github.com/REditorSupport/vscode-R/issues/1201))
* Refactoring: Strict TypeScript Fix #1208 ([#1209](https://github.com/REditorSupport/vscode-R/issues/1209), [#1208](https://github.com/REditorSupport/vscode-R/issues/1208))
* [Chore] Remove unused NPM dependencies fix #232 ([#1216](https://github.com/REditorSupport/vscode-R/issues/1216))
* Support KaTeX in help page viewer ([#1213](https://github.com/REditorSupport/vscode-R/issues/1213))
* Use asExternalUri instead
* Not trigger preview on file change when rmd is still rendering ([#1219](https://github.com/REditorSupport/vscode-R/issues/1219))
* release 2.6.0

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.5.3...v2.6.0>

## 2.5.3 - 2022-09-06

### Other

* Bump terser from 5.7.0 to 5.14.2 ([#1154](https://github.com/REditorSupport/vscode-R/issues/1154))
* Remove encoding param from knitting ([#1167](https://github.com/REditorSupport/vscode-R/issues/1167))
* Reload help pages on help refresh ([#1188](https://github.com/REditorSupport/vscode-R/issues/1188))
* Upgrade to vscode-languageclient 8.0.2 ([#1173](https://github.com/REditorSupport/vscode-R/issues/1173))
* release 2.5.3

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.5.2...v2.5.3>

## 2.5.2 - 2022-07-15

### Bug Fixes

* Workspace viewer fix ([#1150](https://github.com/REditorSupport/vscode-R/issues/1150))

### Other

* Publish to Open VSX Registry ([#1101](https://github.com/REditorSupport/vscode-R/issues/1101))
* Create issues.yml ([#1061](https://github.com/REditorSupport/vscode-R/issues/1061))
* Remove nesting: guard clauses ([#1110](https://github.com/REditorSupport/vscode-R/issues/1110))
* Hide preview env values to prevent accidental deletion ([#1117](https://github.com/REditorSupport/vscode-R/issues/1117))
* Add file creation to file/newFile ([#1119](https://github.com/REditorSupport/vscode-R/issues/1119))
* Bump jquery.json-viewer from 1.4.0 to 1.5.0 ([#1123](https://github.com/REditorSupport/vscode-R/issues/1123))
* Update data viewer column resizing ([#1121](https://github.com/REditorSupport/vscode-R/issues/1121))
* Click code in help views ([#1138](https://github.com/REditorSupport/vscode-R/issues/1138))
* Adapt to lintr 3.0 ([#1141](https://github.com/REditorSupport/vscode-R/issues/1141))
* Whitespace in typescript files ([#1142](https://github.com/REditorSupport/vscode-R/issues/1142))
* Add `Create .linr` command ([#1112](https://github.com/REditorSupport/vscode-R/issues/1112))
* Add .yarnrc
* Upgrade to ag-grid-community 28.0.0 ([#1144](https://github.com/REditorSupport/vscode-R/issues/1144))
* release 2.5.1
* Disable publish to openvsx
* release 2.5.2

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.5.0...v2.5.2>

## 2.5.0 - 2022-05-14

### Bug Fixes

* Fix console err ([#1034](https://github.com/REditorSupport/vscode-R/issues/1034))
* Fix lintr complain

### Other

* add R package build task - build source and build binary like RStudio ([#1029](https://github.com/REditorSupport/vscode-R/issues/1029))
* Use `bindingIsActive` ([#1031](https://github.com/REditorSupport/vscode-R/issues/1031))
* guard against evaluation of active bindings ([#1038](https://github.com/REditorSupport/vscode-R/issues/1038), [#1030](https://github.com/REditorSupport/vscode-R/issues/1030))
* Upgrade `ag-grid-community` to v27.1.0 ([#1049](https://github.com/REditorSupport/vscode-R/issues/1049))
* Hide smart knit env values to prevent accidental deletion ([#1060](https://github.com/REditorSupport/vscode-R/issues/1060))
* Add `r.session.data.pageSize` ([#1068](https://github.com/REditorSupport/vscode-R/issues/1068))
* Bump ansi-regex from 3.0.0 to 3.0.1 ([#1070](https://github.com/REditorSupport/vscode-R/issues/1070))
* Bump minimist from 1.2.5 to 1.2.6 ([#1069](https://github.com/REditorSupport/vscode-R/issues/1069))
* Update rGitignore.ts
* Add lsp settings to support disabling prompt and additional libPaths ([#1071](https://github.com/REditorSupport/vscode-R/issues/1071))
* More choices for code chunk snippet ([#1082](https://github.com/REditorSupport/vscode-R/issues/1082))
* Take out http from `Insert image` Rmd snippet ([#1084](https://github.com/REditorSupport/vscode-R/issues/1084))
* Take out http from link snippet ([#1085](https://github.com/REditorSupport/vscode-R/issues/1085))
* Bump cross-fetch from 3.1.4 to 3.1.5 ([#1087](https://github.com/REditorSupport/vscode-R/issues/1087))
* Bump ejs from 3.1.6 to 3.1.7 ([#1088](https://github.com/REditorSupport/vscode-R/issues/1088))
* Use `loadNamespace` ([#1086](https://github.com/REditorSupport/vscode-R/issues/1086))
* Prompt when no templates found ([#1089](https://github.com/REditorSupport/vscode-R/issues/1089))
* Update publisher id ([#1093](https://github.com/REditorSupport/vscode-R/issues/1093))
* R language server and help supports additional libPaths ([#1097](https://github.com/REditorSupport/vscode-R/issues/1097))
* Move r.libPaths in setting
* Update `r.libPaths` behavior ([#1098](https://github.com/REditorSupport/vscode-R/issues/1098))
* release 2.5.0

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.4.0...v2.5.0>

## 2.4.0 - 2022-03-07

### Bug Fixes

* Fix commented pipe bug ([#988](https://github.com/REditorSupport/vscode-R/issues/988))
* Fix resolveTask ([#994](https://github.com/REditorSupport/vscode-R/issues/994))
* Fix incorrect syntax highlighting for variables starting with "function" ([#992](https://github.com/REditorSupport/vscode-R/issues/992), [#982](https://github.com/REditorSupport/vscode-R/issues/982))

### Other

* Use spawn ([#985](https://github.com/REditorSupport/vscode-R/issues/985))
* WIP: Add problemMatching to task ([#989](https://github.com/REditorSupport/vscode-R/issues/989))
* R markdown templates ([#984](https://github.com/REditorSupport/vscode-R/issues/984))
* Preserve selected text in rmd snippet ([#1001](https://github.com/REditorSupport/vscode-R/issues/1001))
* Provide optional 'code' argument to r.runSelection command ([#1017](https://github.com/REditorSupport/vscode-R/issues/1017))
* Add Shiny snippets ([#1012](https://github.com/REditorSupport/vscode-R/issues/1012), [#1011](https://github.com/REditorSupport/vscode-R/issues/1011))
* Add lambda to function-declarations ([#1025](https://github.com/REditorSupport/vscode-R/issues/1025))
* Enhance workspace viewer ([#1022](https://github.com/REditorSupport/vscode-R/issues/1022))
* Share httpgd url for LiveShare ([#1026](https://github.com/REditorSupport/vscode-R/issues/1026))
* Add some useful Rmd snippets ([#1009](https://github.com/REditorSupport/vscode-R/issues/1009))
* release 2.4.0

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.3.8...v2.4.0>

## 2.3.8 - 2022-02-07

### Other

* Avoid rpath quoting ([#981](https://github.com/REditorSupport/vscode-R/issues/981))
* release 2.3.8

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.3.7...v2.3.8>

## 2.3.7 - 2022-02-07

### Bug Fixes

* Fix rmd comment ([#958](https://github.com/REditorSupport/vscode-R/issues/958))

### Other

* correcting typo on command argument (slient instead of silent) ([#954](https://github.com/REditorSupport/vscode-R/issues/954))
* update the .gitignore file for R ([#949](https://github.com/REditorSupport/vscode-R/issues/949))
* Add delay before refreshing plots ([#956](https://github.com/REditorSupport/vscode-R/issues/956))
* Add row limit setting of data viewer and support Apache Arrow Table ([#945](https://github.com/REditorSupport/vscode-R/issues/945))
* Bump node-fetch from 2.6.1 to 2.6.7 ([#962](https://github.com/REditorSupport/vscode-R/issues/962))
* set the LANG env when rendering rmarkdown ([#961](https://github.com/REditorSupport/vscode-R/issues/961))
* should use Strong quote for shell commands ([#964](https://github.com/REditorSupport/vscode-R/issues/964))
* Add note about required httpgd package version ([#972](https://github.com/REditorSupport/vscode-R/issues/972))
* update dcf syntax and add support ".lintr" file ([#970](https://github.com/REditorSupport/vscode-R/issues/970))
* prompt to install languageserver is not available ([#965](https://github.com/REditorSupport/vscode-R/issues/965))
* [data frame viewer] Add type of column to headerTooltip ([#974](https://github.com/REditorSupport/vscode-R/issues/974))
* Upgrade ag-grid-community to 26.2.1 ([#975](https://github.com/REditorSupport/vscode-R/issues/975))
* Activate extension on subfolder ([#979](https://github.com/REditorSupport/vscode-R/issues/979))
* release 2.3.7

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.3.6...v2.3.7>

## 2.3.6 - 2022-01-16

### Bug Fixes

* Fix syntax file ([#939](https://github.com/REditorSupport/vscode-R/issues/939))

### Other

* Add raw string tokens ([#922](https://github.com/REditorSupport/vscode-R/issues/922))
* Support both single and double brackets in code-server's URI template ([#934](https://github.com/REditorSupport/vscode-R/issues/934))
* Rename `R/session/.Rprofile` to `R/session/profile.R` ([#938](https://github.com/REditorSupport/vscode-R/issues/938))
* Use taskkill for win32 ([#936](https://github.com/REditorSupport/vscode-R/issues/936))
* Fixed `"punctuation.section.parens.end.r"` under `"function-parameters"` ([#931](https://github.com/REditorSupport/vscode-R/issues/931))
* Use `taskkill` for win32 ([#941](https://github.com/REditorSupport/vscode-R/issues/941))
* release 2.3.6

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.3.5...v2.3.6>

## 2.3.5 - 2021-12-18

### Bug Fixes

* Fix dcf syntax ([#920](https://github.com/REditorSupport/vscode-R/issues/920))

### Other

* adding devtools tasks to command palette ([#880](https://github.com/REditorSupport/vscode-R/issues/880))
* RMD - don't set undefined wd ([#914](https://github.com/REditorSupport/vscode-R/issues/914))
* Use `SIGKILL` to kill help server ([#912](https://github.com/REditorSupport/vscode-R/issues/912))
* readability adjustments for help pages ([#915](https://github.com/REditorSupport/vscode-R/issues/915))
* Clean-up child processes on dispose ([#918](https://github.com/REditorSupport/vscode-R/issues/918))
* release 2.3.5

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.3.4...v2.3.5>

## 2.3.4 - 2021-11-30

### Bug Fixes

* Fix helpserver issue ([#893](https://github.com/REditorSupport/vscode-R/issues/893))

### Other

* Remove quotes from rpath if necessary ([#884](https://github.com/REditorSupport/vscode-R/issues/884))
* Try different CRAN URLs ([#885](https://github.com/REditorSupport/vscode-R/issues/885))
* Use `Uri.file` instead of `Uri.parse` ([#888](https://github.com/REditorSupport/vscode-R/issues/888))
* Update bug_report.md
* Clean up of help related files ([#887](https://github.com/REditorSupport/vscode-R/issues/887))
* Use httpgd NPM package ([#823](https://github.com/REditorSupport/vscode-R/issues/823))
* release 2.3.4

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.3.3...v2.3.4>

## 2.3.3 - 2021-11-21

### Bug Fixes

* Fix package installation ([#846](https://github.com/REditorSupport/vscode-R/issues/846))
* Fix detecting yaml frontmatter ([#856](https://github.com/REditorSupport/vscode-R/issues/856))
* Fix rmd preview chunk colouring ([#867](https://github.com/REditorSupport/vscode-R/issues/867))

### Other

* Add R info to status bar item text and tooltip ([#836](https://github.com/REditorSupport/vscode-R/issues/836))
* get knit command from settings ([#841](https://github.com/REditorSupport/vscode-R/issues/841))
* Add support for indented Roxygen ([#847](https://github.com/REditorSupport/vscode-R/issues/847))
* Syntax highlighting for indented roxygen ([#850](https://github.com/REditorSupport/vscode-R/issues/850))
* Use new terminal API ([#851](https://github.com/REditorSupport/vscode-R/issues/851))
* Add backtick to list of quote characters for syntax highlighting. ([#859](https://github.com/REditorSupport/vscode-R/issues/859))
* Auto refresh help ([#863](https://github.com/REditorSupport/vscode-R/issues/863))
* Show httpgd plot on attach ([#852](https://github.com/REditorSupport/vscode-R/issues/852))
* Update lim ([#868](https://github.com/REditorSupport/vscode-R/issues/868))
* release 2.3.3

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.3.2...v2.3.3>

## 2.3.2 - 2021-10-22

### Other

* Httpgd plot viewer respects `r.session.viewers.viewColumn.plot` ([#816](https://github.com/REditorSupport/vscode-R/issues/816))
* Completely replace `View()` ([#818](https://github.com/REditorSupport/vscode-R/issues/818))
* Change help cache default ([#819](https://github.com/REditorSupport/vscode-R/issues/819))
* browser handles `file://` ([#817](https://github.com/REditorSupport/vscode-R/issues/817))
* Add `r.session.levelOfObjectDetail=Normal` for `max.level=1` ([#815](https://github.com/REditorSupport/vscode-R/issues/815))
* Update address
* Check workspace folder with both original and real path ([#827](https://github.com/REditorSupport/vscode-R/issues/827))
* release 2.3.2

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.3.1...v2.3.2>

## 2.3.1 - 2021-10-07

### Other

* Support `VSCODE_PROXY_URI` ([#803](https://github.com/REditorSupport/vscode-R/issues/803))
* Reenable 'unsafe-eval' in script-src CSP ([#805](https://github.com/REditorSupport/vscode-R/issues/805))
* Use r.session.viewers.viewColumn.helpPanel ([#804](https://github.com/REditorSupport/vscode-R/issues/804))
* Use cwd in knit process ([#807](https://github.com/REditorSupport/vscode-R/issues/807))
* Bump version
* release 2.3.1

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.3.0...v2.3.1>

## 2.3.0 - 2021-09-23

### Bug Fixes

* Fix RMD requireNamespace ([#784](https://github.com/REditorSupport/vscode-R/issues/784))
* Fix hljs usage

### Other

* Enable rstudioapi by default ([#769](https://github.com/REditorSupport/vscode-R/issues/769))
* Use unsafe-inline for script-src ([#771](https://github.com/REditorSupport/vscode-R/issues/771))
* R Markdown Enhancements (Knit Manager) ([#765](https://github.com/REditorSupport/vscode-R/issues/765))
* (Refactoring) Simplify RMD child process disposal ([#773](https://github.com/REditorSupport/vscode-R/issues/773))
* Add object length limit ([#778](https://github.com/REditorSupport/vscode-R/issues/778))
* Write NA as string ([#780](https://github.com/REditorSupport/vscode-R/issues/780))
* Use R files for background process ([#783](https://github.com/REditorSupport/vscode-R/issues/783))
* Respect preview output format ([#785](https://github.com/REditorSupport/vscode-R/issues/785))
* Bump @types/vscode from 1.57.0 to 1.60.0 ([#786](https://github.com/REditorSupport/vscode-R/issues/786))
* Extend providers to rmd ([#787](https://github.com/REditorSupport/vscode-R/issues/787))
* Bump nth-check from 2.0.0 to 2.0.1 ([#795](https://github.com/REditorSupport/vscode-R/issues/795))
* Update vscode and ag-grid version
* Update dependencies
* Update highlight.js version
* release 2.3.0

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.2.0...v2.3.0>

## 2.2.0 - 2021-08-21

### Bug Fixes

* Fix date filter in data viewer ([#736](https://github.com/REditorSupport/vscode-R/issues/736))
* Fix README
* Fix  issues with c() in function args ([#751](https://github.com/REditorSupport/vscode-R/issues/751), [#713](https://github.com/REditorSupport/vscode-R/issues/713))

### Other

* Check conflict extension ([#733](https://github.com/REditorSupport/vscode-R/issues/733))
* Rename liveshare folder to liveShare ([#738](https://github.com/REditorSupport/vscode-R/issues/738))
* Viewer fix: invalid html_widget resource paths ([#739](https://github.com/REditorSupport/vscode-R/issues/739))
* Accessing VS Code settings in R ([#743](https://github.com/REditorSupport/vscode-R/issues/743))
* Use .DollarNames with default pattern ([#750](https://github.com/REditorSupport/vscode-R/issues/750))
* Handle error in capture_str ([#756](https://github.com/REditorSupport/vscode-R/issues/756))
* Add icons to webviews ([#759](https://github.com/REditorSupport/vscode-R/issues/759))
* release 2.2.0

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.1.0...v2.2.0>

## 2.1.0 - 2021-07-20

### Bug Fixes

* Fix README links
* Fix typo in url
* Fix typo

### Other

* Minor workspace-related changes ([#672](https://github.com/REditorSupport/vscode-R/issues/672))
* Update README ([#669](https://github.com/REditorSupport/vscode-R/issues/669))
* Enable r.sessionWatcher by default
* Update previewDataframe and previewEnvironment
* Enable r.sessionWatcher by default ([#670](https://github.com/REditorSupport/vscode-R/issues/670))
* Add customization options to plot viewer ([#678](https://github.com/REditorSupport/vscode-R/issues/678))
* Catch LiveShare API errors ([#679](https://github.com/REditorSupport/vscode-R/issues/679))
* Small Plot Viewer adjustments ([#681](https://github.com/REditorSupport/vscode-R/issues/681))
* Integer syntax supports e.g. 1e2L
* Integer syntax supports e.g. 1e2L ([#683](https://github.com/REditorSupport/vscode-R/issues/683))
* Change License owner
* Update url and author
* Update url and author ([#694](https://github.com/REditorSupport/vscode-R/issues/694))
* Preview R Markdown files via background process ([#692](https://github.com/REditorSupport/vscode-R/issues/692))
* RMD Preview fixes ([#699](https://github.com/REditorSupport/vscode-R/issues/699))
* Update r.rmarkdown.codeLensCommands ([#707](https://github.com/REditorSupport/vscode-R/issues/707))
* Remove show plot history command ([#706](https://github.com/REditorSupport/vscode-R/issues/706))
* Add full window mode for plots ([#709](https://github.com/REditorSupport/vscode-R/issues/709))
* Use ag-grid in data viewer ([#708](https://github.com/REditorSupport/vscode-R/issues/708))
* Integrate vscode-r-lsp ([#695](https://github.com/REditorSupport/vscode-R/issues/695))
* prerelease 2.1.0
* release 2.1.0
* release 2.1.0

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v2.0.0...v2.1.0>

## 2.0.0 - 2021-06-12

### Bug Fixes

* Fix getCurrentChunk and use chunks.find for most cases

### Other

* Use .DollarNames for object with class in completion
* Use `.DollarNames` for object with class in completion ([#660](https://github.com/REditorSupport/vscode-R/issues/660))
* Code cells in .R files
* Update rmarkdown.ts
* Remove unused languages
* Code cells in .R files ([#662](https://github.com/REditorSupport/vscode-R/issues/662))
* Squash bugs
* Change source & knit icons
* Jump to cursor
* Remove image files not used
* rmarkdown bug squashing and minor changes ([#663](https://github.com/REditorSupport/vscode-R/issues/663))
* Bump css-what from 5.0.0 to 5.0.1
* Bump css-what from 5.0.0 to 5.0.1 ([#664](https://github.com/REditorSupport/vscode-R/issues/664))
* Bugfix
* LiveShare Functionality ([#626](https://github.com/REditorSupport/vscode-R/issues/626))
* prerelease 2.0.0 ([#667](https://github.com/REditorSupport/vscode-R/issues/667))

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v1.6.8...v2.0.0>

## 1.6.8 - 2021-05-31

### Bug Fixes

* Fix typo in internal file name
* Fix Webview Identification Function ([#650](https://github.com/REditorSupport/vscode-R/issues/650))
* Fix bugs in helpviewer ([#658](https://github.com/REditorSupport/vscode-R/issues/658))

### Other

* Fix typo in internal file name ([#643](https://github.com/REditorSupport/vscode-R/issues/643))
* Revert syntax for lambda
* Revert syntax for lambda ([#657](https://github.com/REditorSupport/vscode-R/issues/657))
* version 1.6.8

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v1.6.7...v1.6.8>

## 1.6.7 - 2021-05-31

### Bug Fixes

* Fix replacing base::.External.graphics
* Fix Github actions
* fix highlight.js

### Other

* Adding markdownlint on extension.json and GitHub Actions ([#591](https://github.com/REditorSupport/vscode-R/issues/591))
* Fix replacing `base::.External.graphics` ([#625](https://github.com/REditorSupport/vscode-R/issues/625))
* Integrate httpgd ([#620](https://github.com/REditorSupport/vscode-R/issues/620))
* Minor fix of README
* Prefer rPath from PATH
* Prefer rPath from PATH ([#649](https://github.com/REditorSupport/vscode-R/issues/649))
* Improve development workflow ([#641](https://github.com/REditorSupport/vscode-R/issues/641))
* Don't run chunks with eval = FALSE. Fixes #651 ([#651](https://github.com/REditorSupport/vscode-R/issues/651))
* Don't run chunks with eval = FALSE. Fixes #651 ([#653](https://github.com/REditorSupport/vscode-R/issues/653), [#651](https://github.com/REditorSupport/vscode-R/issues/651))
* Add pipe and lambda to syntax
* Update doesLineEndInOperator
* Update R syntax ([#647](https://github.com/REditorSupport/vscode-R/issues/647))
* prerelease 1.6.7
* update changelog
* Prerelease 1.6.7 ([#655](https://github.com/REditorSupport/vscode-R/issues/655))

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v1.6.6...v1.6.7>

## 1.6.6 - 2021-04-11

### Bug Fixes

* Fix leading/trailing newlines
* fix package volunerability

### Other

* Update vscode engine
* Update vscode engine ([#586](https://github.com/REditorSupport/vscode-R/issues/586))
* Satisfy markdownlint
* Satisfy markdownlint ([#587](https://github.com/REditorSupport/vscode-R/issues/587))
* Initial Workspace Viewer str() functionality (#577)
* Initial Workspace Viewer str() functionality ([#583](https://github.com/REditorSupport/vscode-R/issues/583))
* Thread execute argument through to term.sendText() ([#585](https://github.com/REditorSupport/vscode-R/issues/585))
* Remove object.size
* Use cache to store object size for objects in globalenv
* Add option vsc.show_object_size
* Update object size when length changes
* Update getSizeString() to be consistent with format() in R
* Being more conservative to call object.size() in task callback ([#581](https://github.com/REditorSupport/vscode-R/issues/581))
* Send code to debug repl
* Send code to debug repl ([#582](https://github.com/REditorSupport/vscode-R/issues/582))
* Clarify R path error messages ([#596](https://github.com/REditorSupport/vscode-R/issues/596))
* Add tasks Check, Document, Install, Test ([#603](https://github.com/REditorSupport/vscode-R/issues/603))
* shim the rstudioapi if it has already been loaded
* make lintr happy
* shim the rstudioapi if it has already been loaded ([#610](https://github.com/REditorSupport/vscode-R/issues/610))
* Clarify error messages ([#607](https://github.com/REditorSupport/vscode-R/issues/607))
* version 1.6.6

### Refactor

* Refactor R code ([#602](https://github.com/REditorSupport/vscode-R/issues/602))

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v1.6.5...v1.6.6>

## 1.6.5 - 2021-03-15

### Bug Fixes

* Fix get_timestamp() so that it will not be affected by e.g. options(digits=3) ([#550](https://github.com/REditorSupport/vscode-R/issues/550))
* Fix so code can be run after creating terminal
* Fix #572 ([#572](https://github.com/REditorSupport/vscode-R/issues/572))

### Other

* Change workspace tooltip ([#544](https://github.com/REditorSupport/vscode-R/issues/544))
* add option vsc.hover.str.max.level ([#545](https://github.com/REditorSupport/vscode-R/issues/545))
* Refactoring and implementation of webviewPanelSerializer ([#556](https://github.com/REditorSupport/vscode-R/issues/556))
* Scroll to bottom after running a command ([#559](https://github.com/REditorSupport/vscode-R/issues/559))
* Add option to keep terminal hidden
* Clarify r.source.focus options in description
* Add option to keep terminal hidden after running code ([#566](https://github.com/REditorSupport/vscode-R/issues/566))
* Check rTerm is defined before showing
* Fix so code can be run after creating terminal ([#567](https://github.com/REditorSupport/vscode-R/issues/567))
* Move `r.runSource` and `r.knitRmd` to `editor/title/run` (Fix #572) ([#573](https://github.com/REditorSupport/vscode-R/issues/573), [#572](https://github.com/REditorSupport/vscode-R/issues/572))
* Add links to help pages in hover
* Improve the formatting
* Add links to help pages in hover ([#578](https://github.com/REditorSupport/vscode-R/issues/578))
* version 1.6.5
* update vscode engine

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v1.6.4...v1.6.5>

## 1.6.4 - 2021-02-01

### Other

* Better error message when reading aliases ([#518](https://github.com/REditorSupport/vscode-R/issues/518))
* Keep promises and active bindings in globalenv ([#521](https://github.com/REditorSupport/vscode-R/issues/521))
* (Maybe) Fix Aliases ([#526](https://github.com/REditorSupport/vscode-R/issues/526))
* add sendToConsole to rstudioapi emulation ([#535](https://github.com/REditorSupport/vscode-R/issues/535))
* Add updatePackage command ([#532](https://github.com/REditorSupport/vscode-R/issues/532))
* Add initial pipeline completion support ([#530](https://github.com/REditorSupport/vscode-R/issues/530))
* Add function to open help for selected text ([#531](https://github.com/REditorSupport/vscode-R/issues/531))
* Preserve focus when opening help view ([#541](https://github.com/REditorSupport/vscode-R/issues/541))
* update packages
* version 1.6.4
* Prerelease version 1.6.4 ([#542](https://github.com/REditorSupport/vscode-R/issues/542))
* version 1.6.4

### Refactor

* Refactor extension.ts ([#525](https://github.com/REditorSupport/vscode-R/issues/525))
* refactor import statements

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v1.6.3...v1.6.4>

## 1.6.3 - 2021-01-01

### Other

* Implement R workspace viewer ([#476](https://github.com/REditorSupport/vscode-R/issues/476))
* add a new collaborator
* Conditionally show view ([#487](https://github.com/REditorSupport/vscode-R/issues/487))
* Enable find widget in WebViews ([#490](https://github.com/REditorSupport/vscode-R/issues/490))
* Find in topic (help panel) #463 ([#488](https://github.com/REditorSupport/vscode-R/issues/488))
* Disable alwaysShow for addin items ([#491](https://github.com/REditorSupport/vscode-R/issues/491))
* Only show R menu items in R view ([#493](https://github.com/REditorSupport/vscode-R/issues/493))
* Modify pre-release action ([#492](https://github.com/REditorSupport/vscode-R/issues/492))
* Add browser WebView command buttons ([#494](https://github.com/REditorSupport/vscode-R/issues/494))
* typo fix
* typo fix ([#500](https://github.com/REditorSupport/vscode-R/issues/500))
* Improve help view ([#502](https://github.com/REditorSupport/vscode-R/issues/502))
* releaseAction ([#505](https://github.com/REditorSupport/vscode-R/issues/505))
* Strict null checking in help related code ([#507](https://github.com/REditorSupport/vscode-R/issues/507))
* WIP: Pre fixing for version 1.6.3 ([#508](https://github.com/REditorSupport/vscode-R/issues/508))
* version 1.6.3

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v1.6.2...v1.6.3>

## 1.6.2 - 2020-12-06

### Bug Fixes

* Fix bug that would leave background R processes running ([#475](https://github.com/REditorSupport/vscode-R/issues/475))
* Fix whole of style (Extends #361) ([#474](https://github.com/REditorSupport/vscode-R/issues/474))

### Other

* Add pre-release ([#468](https://github.com/REditorSupport/vscode-R/issues/468))
* Improve Help Panel ([#470](https://github.com/REditorSupport/vscode-R/issues/470))
* RMarkdown: Add run & navigation commands. More customization. Refactor. ([#465](https://github.com/REditorSupport/vscode-R/issues/465))
* Fixes #443 ([#462](https://github.com/REditorSupport/vscode-R/issues/462))
* Reorganize helppanel, add `?` function ([#477](https://github.com/REditorSupport/vscode-R/issues/477))
* Update README for #465
* Update README for #465 ([#480](https://github.com/REditorSupport/vscode-R/issues/480))
* Improve style of help pages ([#481](https://github.com/REditorSupport/vscode-R/issues/481))
* Modify config ([#467](https://github.com/REditorSupport/vscode-R/issues/467))
* update devreplay rules
* back the previous custom rules
* version 1.6.2

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v1.6.1...v1.6.2>

## 1.6.1 - 2020-11-24

### Bug Fixes

* Fix type in help panel path config
* Fix lint: missing semicolon
* Fix checking workspaceFolders in rHelpProviderOptions

### Other

* Don't use rterm as fallback for help panel R path
* Fix typo in help panel path config ([#457](https://github.com/REditorSupport/vscode-R/issues/457))
* New feature r.runFromLineToEnd
* New feature r.runFromLineToEnd ([#448](https://github.com/REditorSupport/vscode-R/issues/448))
* Also check length
* Fix checking workspaceFolders in rHelpProviderOptions ([#456](https://github.com/REditorSupport/vscode-R/issues/456))
* Highlight all chunks
* Highlight all chunks ([#453](https://github.com/REditorSupport/vscode-R/issues/453))
* Add GitHub Action for release
* Add GitHub Action for release ([#449](https://github.com/REditorSupport/vscode-R/issues/449))
* Add Rmd fenced_block_* for julia, python, etc
* Rmd fenced block syntax highlighting for julia, python, etc ([#460](https://github.com/REditorSupport/vscode-R/issues/460))
* Update README: Add options(vsc.helpPanel = ...)
* Update README: Add options(vsc.helpPanel = ...) ([#461](https://github.com/REditorSupport/vscode-R/issues/461))
* version 1.6.1

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v1.6.0...v1.6.1>

## 1.6.0 - 2020-11-21

### Bug Fixes

* Fix usage of GlobPattern
* Fix leading slash in tmpDir path
* Fix showWebView
* Fix build.yml
* Fix handling group_df in dataview_table
* fix extension tslint to eslint
* fix #265 ([#265](https://github.com/REditorSupport/vscode-R/issues/265))
* Fix main.yml
* Fix eslint
* fix vlunerability
* fix vscode version
* Fix code formatting
* Fix main.yml
* Fix .lintr
* Fix .Rprofile line length
* fix package dependencies
* fix package-lock.json
* Fix typo in showWebView
* fix devreplay error
* Fix lintr github action
* Fix new test cases
* Fix outFiles in launch.json
* Fix View empty environment
* Fix typo in README.md
* Fix homedir on Windows
* fix for new conventions
* fix config title r to R
* Fix viewer and page_viewer url
* Fix plot viewer
* Fix typo
* Fix typo
* fix dependencies
* Fix previewDataframe for 2+ letter variables
* Fix so rTerm is undefined when deleting terminal
* fix package volunerability
* Fix more functions to use runTextInTerm
* fix package dependencies
* fix webpack for the new webpack interface
* Fix linting message
* fix and enhance navigateToFile
* fix toString -> toString()

### Other

* version 1.2.2
* Update FAQ
* Add logging to session watcher
* Add more logging to session watcher ([#208](https://github.com/REditorSupport/vscode-R/issues/208))
* updateResponse only handles response when responseLineCount increases
* updateResponse only handles response when responseLineCount changes
* Avoid duplicate handling of response update ([#211](https://github.com/REditorSupport/vscode-R/issues/211))
* first tslint cleanup
* Update activationEvents
* Update activationEvents
* Update activationEvents ([#224](https://github.com/REditorSupport/vscode-R/issues/224))
* Add syntax highlighting for R code in Rcpp comment
* Add syntax highlighting for R code in Rcpp comment ([#225](https://github.com/REditorSupport/vscode-R/issues/225))
* Fixed the function snippet (Issue #230)
* Fixed the function snippet (Issue #230) ([#231](https://github.com/REditorSupport/vscode-R/issues/231))
* add collaborator
* version 1.2.3
* update vscode
* Add statement of languageserver features to bug_report.md
* Add statement of languageserver features to bug report template ([#229](https://github.com/REditorSupport/vscode-R/issues/229))
* string interpolation command runner
* add runCommandWithPath and clean
* swtich to '$$' replacement target, editor paths unquoted
* Add command runner function doco to README
* add quotes to runCommandWithPath example
* handle unsaved and unititled files
* global replace enabled for $$
* use escaped double quotes in keybinding example
* Add configurable command runner functions ([#237](https://github.com/REditorSupport/vscode-R/issues/237))
* Minor refine README.md
* Fix leading slash in tmpDir path ([#221](https://github.com/REditorSupport/vscode-R/issues/221))
* Change platform gui in init.R
* Change .Platform$GUI to vscode on session start ([#234](https://github.com/REditorSupport/vscode-R/issues/234))
* Inject R Markdown features into Markdown grammar
* Remove non-bracket code chunks from R Markdown grammar
* Inject R Markdown features into Markdown grammar ([#228](https://github.com/REditorSupport/vscode-R/issues/228))
* version 1.2.4
* version 1.2.5
* Check untitled document and save result before running command
* Update code
* Check untitled document and save result before running command ([#239](https://github.com/REditorSupport/vscode-R/issues/239))
* Fix showWebView ([#246](https://github.com/REditorSupport/vscode-R/issues/246))
* version 1.2.6
* Add lint workflows
* Rename lint action name
* Combine lint workflows
* Use GitHub Actions for linting ([#251](https://github.com/REditorSupport/vscode-R/issues/251))
* Add build.yml
* Combine to single main.yml
* Refine main.yml
* Use GitHub Actions to build extension ([#253](https://github.com/REditorSupport/vscode-R/issues/253))
* Use Windows registry to find R path
* Refine getRpath
* Update package dependencies
* Add logging
* Use async getRpath()
* Update README.md
* Use Windows registry to find R path ([#252](https://github.com/REditorSupport/vscode-R/issues/252))
* Fix handling grouped_df in dataview_table ([#248](https://github.com/REditorSupport/vscode-R/issues/248))
* try to adding eslint
* version 1.2.7
* try to adding eslint ([#254](https://github.com/REditorSupport/vscode-R/issues/254))
* Add wiki link on README
* support single quote
* add backtick support
* Support single quote (Fix #260) ([#264](https://github.com/REditorSupport/vscode-R/issues/264), [#260](https://github.com/REditorSupport/vscode-R/issues/260))
* Use eslint in GitHub Actions
* Update package-lock.json
* Use setup-node
* Use eslint in GitHub Actions ([#266](https://github.com/REditorSupport/vscode-R/issues/266))
* Add languages embedded in markdown
* Add surround support for R Markdown files
* Add backtick support for R documentation files
* Remove backtick auto-closing pair for R Markdown
* Add R Markdown surround and frontmatter comments ([#269](https://github.com/REditorSupport/vscode-R/issues/269))
* update eslint rules
* back tsconfig and remove tslint
* version 1.2.8
* Update lintr
* Fix R code formatting according to linting results ([#278](https://github.com/REditorSupport/vscode-R/issues/278))
* Use env to specify vsix file in github actions build
* Make rebind also work in attached packages
* Make rebind also work with attached packages ([#268](https://github.com/REditorSupport/vscode-R/issues/268))
* Make plot update more smart using magic null dev size
* Refine code
* Make plot update smarter using magic null dev size ([#274](https://github.com/REditorSupport/vscode-R/issues/274))
* lintr action error on any non-empty lintr result
* Fix lintr action ([#280](https://github.com/REditorSupport/vscode-R/issues/280))
* Remove --no-site-file from default r.rterm.option
* Remove --no-site-file from default r.rterm.option ([#284](https://github.com/REditorSupport/vscode-R/issues/284))
* Source Rprofile.site at last
* Remove Rprofile.site
* Update .Rprofile
* Update .Rprofile
* Improve .Rprofile ([#282](https://github.com/REditorSupport/vscode-R/issues/282))
* update vscode engine
* Change so setting changes take effect immediately ([#301](https://github.com/REditorSupport/vscode-R/issues/301))
* version 1.3.0
* update contributing.md
* Refine .Rprofile
* Refine .Rprofile to remove unnecessary printing in R startup message. ([#303](https://github.com/REditorSupport/vscode-R/issues/303))
* Change runTextInTerm to string from string[]
* Change signatures to string from string[]
* Simplify removeCommentedLines
* Use bracketed paste for more commands #294 ([#305](https://github.com/REditorSupport/vscode-R/issues/305))
* Add command Run from Beginning to Line
* Add command Run from Beginning to Line ([#290](https://github.com/REditorSupport/vscode-R/issues/290))
* add devreplay
* Making the vscode-r original coding conventions ([#308](https://github.com/REditorSupport/vscode-R/issues/308))
* merge 3 repeated keyword.operator.comparison.r in r.json file.
* merge 3 repeated keyword.operator.comparison.r in r.json file. ([#311](https://github.com/REditorSupport/vscode-R/issues/311))
* Fix typo in showWebView ([#310](https://github.com/REditorSupport/vscode-R/issues/310))
* No remove blank or comment lines
* Remove removeCommentedLines as unused
* Remove checkForBlankOrComment as unused
* No remove blank or comment lines ([#313](https://github.com/REditorSupport/vscode-R/issues/313))
* Add vscode-test dependency
* Update package-lock.json after adding vscode-test
* Update scripts for test and pretest
* Add runTest.ts and index.ts for new test format
* Remove old format test index.ts
* Move test file
* Update path
* Change double quotes to single quotes
* Update tsconfig.json for new test format
* Remove launch configuration Launch Tests
* Ignore .vscode-test
* Add test to github actions
* Refine test github action
* Migrate to vscode-test #315 ([#317](https://github.com/REditorSupport/vscode-R/issues/317))
* Fix lintr github action ([#319](https://github.com/REditorSupport/vscode-R/issues/319))
* extendSelection only handles brackets outside quotes
* Add test cases for extendSelection and fix formatting
* Refine condition flow
* Add test/*.ts to eslint
* Refine eslint github action
* extendSelection only handles brackets outside quotes ([#314](https://github.com/REditorSupport/vscode-R/issues/314))
* Add r.runSelectionRetainCursor
* Add r.runSelectionRetainCursor ([#325](https://github.com/REditorSupport/vscode-R/issues/325))
* Add launch tests to launch.json
* Update launch.json
* Update tasks.json and launch.json
* Update launch.json and tasks.json
* Update launch.json and tasks.json
* Add launch tests to launch.json ([#320](https://github.com/REditorSupport/vscode-R/issues/320))
* supress auto-opening quote in roxygen comment
* supress auto-opening quote in roxygen comment ([#328](https://github.com/REditorSupport/vscode-R/issues/328))
* converted Rmd file to json format
* converted Rcpp language file to json
* converted RD language file to json
* converted indentation to spaces to be consistent
* Convert language files to Json ([#333](https://github.com/REditorSupport/vscode-R/issues/333))
* exposure send text delay as a parameter
* changed description of rtermsenddelay; stopped multiple config reads
* expose send text delay as a parameter ([#336](https://github.com/REditorSupport/vscode-R/issues/336))
* Added functionality to switch to active R terminal
* fixed rTermNameOptions typo
* updated to select last created Rterminal
* Added functionality to switch to an existing R terminal ([#338](https://github.com/REditorSupport/vscode-R/issues/338))
* added functionality to search PATH in mac/linux
* updated to auto detect R on windows as well
* added missing argument type
* Enable default R location to be used on mac/linux if none is supplied ([#340](https://github.com/REditorSupport/vscode-R/issues/340))
* add dcf
* add syntax highlight for DESCRIPTION and .Rproj ([#342](https://github.com/REditorSupport/vscode-R/issues/342))
* Define lint in package.json and use it in GitHub Actions
* Update main.yml
* Define lint in package.json and use it in GitHub Actions ([#344](https://github.com/REditorSupport/vscode-R/issues/344))
* version 1.4.0
* Fix View empty environment ([#350](https://github.com/REditorSupport/vscode-R/issues/350))
* Use fs.watch instead of vscode.FileSystemWatcher
* Only handle request of R session started from workspace folders or subfolders
* Use request lock file to avoid partial change
* Use plot.lock and globalenv.lock
* Update README.md
* Update init.R
* Not source init.R in RStudio
* Use fs.watch instead of vscode.FileSystemWatcher ([#348](https://github.com/REditorSupport/vscode-R/issues/348))
* Improve getBrowserHtml
* Improve getBrowserHtml ([#353](https://github.com/REditorSupport/vscode-R/issues/353))
* Change runSelectionInActiveTerm effect to warning
* Change runSelectionInActiveTerm effect to warning ([#351](https://github.com/REditorSupport/vscode-R/issues/351))
* update/remove packages
* version 1.4.1
* Initial rewrite of init.R
* Rewrite session watcher
* Update init.R
* Update options
* Update options
* Update options
* Use viewer === false to open externally
* Clean up and use .vsc.attach()
* Support htmlwidget input and title in viewer and page_viewer
* Rename parseResult to request
* normalizePath in webview
* Session watcher options ([#359](https://github.com/REditorSupport/vscode-R/issues/359))
* Remove single quote from doesLineEndInOperator
* Add test cases for extendSelection with quotes
* Remove single quote from doesLineEndInOperator ([#357](https://github.com/REditorSupport/vscode-R/issues/357))
* update CHANGELOG for following #359
* Update changelog
* Update changelog ([#362](https://github.com/REditorSupport/vscode-R/issues/362))
* version 1.4.2
* update change log links
* Add session watcher functions and options to README
* Update README
* Update README
* Update README
* Update README
* Update README
* Update README
* Fix plot viewer ([#365](https://github.com/REditorSupport/vscode-R/issues/365))
* Minor update readme
* Accept all dir when no workspace folder is open
* Only accept session started from home folder
* Handle undefined workspace folders ([#367](https://github.com/REditorSupport/vscode-R/issues/367))
* On Mac & Linux, rely on PATH being set up
* Update package.json
* On Mac & Linux, rely on PATH being set up ([#374](https://github.com/REditorSupport/vscode-R/issues/374))
* version 1.4.3
* update webpack options
* update mocha option
* version 1.4.4
* Fix previewDataframe for 2+ letter variables ([#390](https://github.com/REditorSupport/vscode-R/issues/390))
* fixed typo and added sep choice
* fixed typo and added sep choice ([#397](https://github.com/REditorSupport/vscode-R/issues/397))
* Fix so rTerm is undefined when deleting terminal ([#403](https://github.com/REditorSupport/vscode-R/issues/403))
* Restore R_PROFILE_USER
* Restore R_PROFILE_USER ([#392](https://github.com/REditorSupport/vscode-R/issues/392))
* Remove Ctrl + 1, 2, 3, 4, 5 shortcuts
* Update CHANGELOG for removing Ctrl + 1, 2, 3, 4, 5
* Remove Ctrl + 1, 2, 3, 4, 5 shortcuts ([#401](https://github.com/REditorSupport/vscode-R/issues/401))
* version 1.4.5
* Check url in browser
* Use path_to_uri in browser
* Check url in browser ([#406](https://github.com/REditorSupport/vscode-R/issues/406))
* Remove active parameter from chooseTerminal()
* Remove term parameter from runTextInTerm()
* Remove chooseTerminalAndSendText()
* Remove term parameter from runSelectionInTerm()
* Remove command runSelectionInActiveTerm
* Remove trailing whitespace
* Remove command Run Selection/Line in Active Terminal ([#409](https://github.com/REditorSupport/vscode-R/issues/409))
* Remove Run in Active Terminal from README
* Remove Run in Active Terminal from README ([#413](https://github.com/REditorSupport/vscode-R/issues/413))
* version 1.4.6
* update change log
* Recommend radian in README
* Recommend radian in README ([#420](https://github.com/REditorSupport/vscode-R/issues/420))
* RStudio Addin Support ([#408](https://github.com/REditorSupport/vscode-R/issues/408))
* remove winattr for the character error
* add missed file
* version 1.5.0
* make update addin registry a safe call
* tested glitch protection in addin.dcf read
* supply actual version numbers to keep {cli} happy
* require rstudioapi emulation be enabled via option
* note about option in README
* move tryCatch to dcf read/parse
* move guards for vsc.rstudioapi
* move rstudioapi_enabled to init.R
* lintr fixes
* don't need active rTerm
* Fix issues in rstudioapi emulation ([#422](https://github.com/REditorSupport/vscode-R/issues/422))
* Rename init functions
* Rename init functions ([#425](https://github.com/REditorSupport/vscode-R/issues/425))
* version 1.5.1
* Use help_type='html' only when unspecified
* Print url before sending browser request to trigger auto port-forwarding
* Improve handling html help ([#427](https://github.com/REditorSupport/vscode-R/issues/427))
* fix and enhance navigateToFile ([#430](https://github.com/REditorSupport/vscode-R/issues/430))
* Enhance R markdown support ([#429](https://github.com/REditorSupport/vscode-R/issues/429))
* version 1.5.2
* Add runAboveChunks command
* Drop empty chunks in runChunksInTerm
* Send trimmed text from chunks
* Add runAboveChunks command ([#434](https://github.com/REditorSupport/vscode-R/issues/434))
* patform independent content string splitting
* nicer error when can't find list of rstudio addins
* platform independent content string splitting ([#436](https://github.com/REditorSupport/vscode-R/issues/436))
* Merge remote-tracking branch 'upstream/master'
* remove full stop
* Friendly error message when trying to launch addin picker and vsc.rstudioapi = FALSE ([#441](https://github.com/REditorSupport/vscode-R/issues/441))
* Send code at EOF appends new line
* Send code at EOF appends new line ([#444](https://github.com/REditorSupport/vscode-R/issues/444))
* Add terminal information to chooseTerminal error ([#447](https://github.com/REditorSupport/vscode-R/issues/447))
* Integrate help view from vscode-R-help ([#433](https://github.com/REditorSupport/vscode-R/issues/433))
* version 1.6.0

### Refactor

* refactor

### Styling

* style fix

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v1.2.1-20200124-625ae35...v1.6.0>

## 1.2.1-20200124-625ae35 - 2020-01-24

### Bug Fixes

* fix PositionNeg implementation
* fix depencency
* fix defaul  runSelection
* fix SetFocus to choose terminal
* Fix to allow creation of first terminal
* Fix check for Excel Viewer extension
* fix for valunerability
* Fix for R markdown config
* Fix Preview Environment for multi-class objects
* Fix Preview Environment for variable x
* fix for tslint
* fix package dependencies
* fix behaviour when workplacefolders is Undefiend
* fix LICENSE to MIT
* fix vlunerable packages
* Fix function call closing bracket highlight
* Fix typo in init.R
* Fix for tslint
* Fix error message
* Fix bootstrap dependency
* Fix #168 ([#168](https://github.com/REditorSupport/vscode-R/issues/168))
* Fix session watcher init.R path on Windows
* Fix typo
* Fix typo
* fix style
* Fix type check for completion of function
* Fix usage of CancellationToken
* Fix WebView Uri replacing
* Fix dataview_table handling single row data

### Other

* Update ISSUE_TEMPLATE.md
* add wordPattern (fixed #75) ([#75](https://github.com/REditorSupport/vscode-R/issues/75))
* version 0.6.2
* sorry, I can not continue support
* version 1.0.1
* version 1.0.2
* Update issue templates
* Create PULL_REQUEST_TEMPLATE.md
* Update bug_report.md
* typo
* Preview Dataframe checks for whitespace
* Preview Dataframe command works again
* Fix Preview Dataframe command #67 ([#97](https://github.com/REditorSupport/vscode-R/issues/97))
* version 1.0.3
* Adapt runSelection to use RCommands as Shortcut
* Adapt runSelection to use RCommands as Shortcut ([#101](https://github.com/REditorSupport/vscode-R/issues/101))
* version 1.0.4
* version 1.0.5
* Add runSelectionInActiveTerm
* Add first terminal check to chooseTerminal
* Add animation showing SSH use
* Add runSelectionInActiveTerm command #80 #102 ([#104](https://github.com/REditorSupport/vscode-R/issues/104))
* miss to merge
* version 1.0.7
* .gitignore is now working
* version 1.0.8
* Fix check for Excel Viewer extension #96 ([#108](https://github.com/REditorSupport/vscode-R/issues/108))
* add gc-excel installer
* version 1.0.9
* version 1.1.0
* Fix Preview Environment for multi-class objects #111 ([#113](https://github.com/REditorSupport/vscode-R/issues/113))
* Fix Preview Environment for variable x #111 ([#115](https://github.com/REditorSupport/vscode-R/issues/115))
* version 1.1.1
* version 1.1.2
* Add bracketed paste mode option
* Do not send blank lines to console
* Fix send code for newlines and Radian #114 #117 ([#119](https://github.com/REditorSupport/vscode-R/issues/119))
* Added Rmd knit shortcut
* Add knit to PDF command
* Added HTMl and all as Knit options
* Remove icons for all but Knit default
* RMarkdown knit support ([#122](https://github.com/REditorSupport/vscode-R/issues/122))
* version 1.1.3
* Fixed spelling, improved formatting
* Fixed spelling, improved formatting ([#129](https://github.com/REditorSupport/vscode-R/issues/129))
* Automatically comment new lines in roxygen sections
* Automatically comment new lines in roxygen sections #124 ([#130](https://github.com/REditorSupport/vscode-R/issues/130))
* Do not send blank lines ending in CRLF to console
* Fix send code for newlines on Windows #114 ([#125](https://github.com/REditorSupport/vscode-R/issues/125))
* add roxygen comments
* Add auto-completion of roxygen tags
* Add auto-completion of roxygen tags #128 ([#131](https://github.com/REditorSupport/vscode-R/issues/131))
* Change cursorMove
* Change cursorMove to wrappedLineFirstNonWhitespaceCharacter ([#127](https://github.com/REditorSupport/vscode-R/issues/127))
* version 1.1.4
* replace deprecated function
* Remove redundant functions
* Move send text functions into rTerminal
* Add alwaysUseActiveTerminal setting
* Add alwaysUseActiveTerminal to README, templates
* Add alwaysUseActiveTerminal setting #123 ([#133](https://github.com/REditorSupport/vscode-R/issues/133))
* version 1.1.5
* Show r.term.option value in settings UI
* Show r.term.option value in settings UI ([#136](https://github.com/REditorSupport/vscode-R/issues/136))
* fix behaviour when workplacefolders is Undefiend ([#138](https://github.com/REditorSupport/vscode-R/issues/138))
* refactoring
* version 1.1.6
* remove duplicated quote #139
* version 1.1.7
* Use word under cursor for previewDataframe, nrow
* Apply functions once instead of to each line
* remove extra calling
* Use word under cursor for previewDataframe, nrow #137 ([#141](https://github.com/REditorSupport/vscode-R/issues/141))
* Delete LICENSE
* Create LICENSE
* version 1.1.8
* version 1.1.8
* Delete LICENSE
* Send code all at once in bracketed paste mode
* Use no bracketed paste characters on Windows
* Fix bracketed paste on Windows ([#149](https://github.com/REditorSupport/vscode-R/issues/149))
* Fix function call closing bracket highlight ([#151](https://github.com/REditorSupport/vscode-R/issues/151))
* version 1.1.9
* Hover works with update
* Attach active command switches session
* Detects changes to plot
* First implementation of showWebView
* Not change pid on webview response
* Use vscode.open to open plot file on update
* Markdown hover text
* Update view column
* Update webview options
* Use console logging
* start log watcher on activation
* Add status bar item
* Update status bar
* Add session init R script
* Add opt-in r.sessionWatcher option
* Implement deploySessionWatcher
* Read file in async method
* Refine updateSessionWatcher
* Remove unused data output init.R
* Add plot hook in session init.R to support ggplot2
* Remove session files on terminal close
* Add rebind to init.R
* Add time stamp in respond
* Implement showDataView
* Force color in showWebView
* Update table class
* Refine table font size
* Include dataview resources
* Support View matrix
* Not rely on tempdir(check=TRUE) which requires R >= 3.5.0
* Support browser command
* Add portMapping to WebView created in showBrowser
* Change name and title of browser WebView
* Change WebView title of browser
* Use workspaceFolders instead of deprecated rootPath
* Use WebView.asWebviewUri
* Use WebView.asWebviewUri
* Add R session watcher section to README.md
* Update README.md
* Use json for View(data.frame)
* Refine table_to_json in init.R
* Check windows in source script
* Check if init.R already sourced
* Use DataTables JS sourced data for View(data.frame)
* Refine showDataView
* remove outside files
* Use webpack to copy resources to dist
* Remove resources folder as no longer needed
* Update README.md
* Use column.type to fix ordering in View
* R session watcher ([#150](https://github.com/REditorSupport/vscode-R/issues/150))
* version 1.2.0
* Use empty order when creating DataTables in getTableHtml
* Use empty order when creating DataTables in getTableHtml ([#157](https://github.com/REditorSupport/vscode-R/issues/157))
* Use utils::str in init.R ([#169](https://github.com/REditorSupport/vscode-R/issues/169))
* Fix session watcher init.R path on Windows ([#177](https://github.com/REditorSupport/vscode-R/issues/177))
* Support View(environment)
* Add initial support of View(function)
* Handle function in showDataView
* Support View any object
* Support View list that cannot be converted to json
* Make init.R more robust
* Make init.R more robust
* Refine init.R and use html help by default
* Use retainContextWhenHidden in all WebViews
* Update init.R
* Use FixedHeader extension in View(data.frame)
* Add row id to dataview_table for table without row names
* Extend View ([#161](https://github.com/REditorSupport/vscode-R/issues/161))
* version 1.2.1
* Update issue templates
* Provide completion for session symbols
* Update README.md
* Provide completion for elements in list-like objects
* Implement bracket completions
* Unify completion provider
* Use tryCatch in update
* Provide bracket completion with condition
* Provide completion for session symbols ([#165](https://github.com/REditorSupport/vscode-R/issues/165))
* Initial implementation of plot history
* Make image viewer center of page
* Update plot history WebView and resources
* Add some error handling
* Show plot history ([#181](https://github.com/REditorSupport/vscode-R/issues/181))
* Add row hover and select
* Use table-active as selected row style
* Add row hover and select ([#186](https://github.com/REditorSupport/vscode-R/issues/186))
* Fix WebView Uri replacing ([#188](https://github.com/REditorSupport/vscode-R/issues/188))
* Show page_viewer WebView in Active column
* Show WebView triggered by page_viewer in Active column ([#189](https://github.com/REditorSupport/vscode-R/issues/189))
* Fix dataview_table handling single row data ([#198](https://github.com/REditorSupport/vscode-R/issues/198))
* Use dev.args option when creating png device before replay
* Use dev.args option when creating png device before replay ([#182](https://github.com/REditorSupport/vscode-R/issues/182))
* Update session watcher section in README.md
* Update README.md
* Update README.md
* Update README.md
* Add link and short description of radian
* Use R_PROFILE_USER
* init.R only work with TERM_PROGRAM=vscode
* Update README.md
* Respect existing R_PROFILE_USER
* Update README.md
* Update README.md
* Improve session watcher initialization ([#184](https://github.com/REditorSupport/vscode-R/issues/184))

### Refactor

* refactor
* refactor and add webpack

### Styling

* style fix

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.6.1...v1.2.1-20200124-625ae35>

## 0.6.1 - 2018-08-17

### Bug Fixes

* Fix for #42
* fix CO
* fix #65 ([#65](https://github.com/REditorSupport/vscode-R/issues/65))
* fix tsconfig to publish
* fix dependencies
* fix categories
* fix dependency and lintr
* fix readability

### Other

* update dependency
* Fix for #42 ([#63](https://github.com/REditorSupport/vscode-R/issues/63))
* revert fix
* version 0.5.8
* version 0.5.9
* remove lint function
* version 0.6.0
* Issue 26: Added detection of bracket and pipe blocks.
* Issue 26: Added detection of bracket and pipe blocks. ([#82](https://github.com/REditorSupport/vscode-R/issues/82))
* version 0.6.1

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.5.7...v0.6.1>

## 0.5.7 - 2018-04-22

### Bug Fixes

* fix grammer based on atom
* Fix for #61

### Other

* update some dependencies
* version 0.5.6
* disable lintr from default
* Additional Fix #61 ([#61](https://github.com/REditorSupport/vscode-R/issues/61))
* version 0.5.7

### Refactor

* refactor

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.5.5...v0.5.7>

## 0.5.5 - 2018-03-21

### Other

* Add package dev commands
* Add package dev commands ([#58](https://github.com/REditorSupport/vscode-R/issues/58))
* version 0.5.5

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.5.4...v0.5.5>

## 0.5.4 - 2018-02-17

### Bug Fixes

* fix
* fix lint
* fix Readme
* fix change log
* fix import order
* fix R syntax grammer
* fix light icon path
* Fix syntax
* fix by tslint
* fix lintr issue on windows
* fix document style
* fix default rterm.option
* fix default rterm
* fix snippets

### Other

* Update README.md
* Update README.md
* Update README.md
* add shortcut
* version 0.4.0
* source r short cut
* add SourcewithEcho
* version 0.4.2
* init next function
* Added dataframe viewer
* Added sample data sets to demonstrate 5mb bug
* Mac and Linux hidden folder and disposal
* Cleaned up Preview Dataframe
* Cleaned package.json
* Restored package.json
* Added DS_Store to .gitignore
* Removed DS_Store
* Added Dataviewer Command ([#20](https://github.com/REditorSupport/vscode-R/issues/20))
* version 0.4.3
* lint fix
* add run source icon
* version 0.4.4
* add document
* Create CODE_OF_CONDUCT.md
* Added data frame preview GIF
* Added Data frame GIF as img
* Corrected Markdown to Display GIF
* little fix
* update run icon(fix #21) ([#21](https://github.com/REditorSupport/vscode-R/issues/21))
* remove extra test
* Fixed dataframe preview on win32; hidden folder and longer write wait
* Updated Dataframe Preview filesize limit
* remove extra dependencies
* Merge remote-tracking branch 'upstream/master'
* Update TODO
* version 0.4.5
* Environment preview #23
* version 0.4.5
* remove extra files
* update typescript version
* update syntax
* mobr test files
* Update Readme and vesion up
* update some snippets from VS
* Attend win short cut
* version 0.4.8
* Create ISSUE_TEMPLATE.md
* Slowed commands being pushed on RTerm
* Removed new line
* Proposed fix for Load Chunk problems #27 ([#31](https://github.com/REditorSupport/vscode-R/issues/31))
* Added block detection and execute whole block
* Added warning if R client is not located.  Corrected space in warning
* Added block detection and execute whole block ([#32](https://github.com/REditorSupport/vscode-R/issues/32))
* add white space
* add shebang support for R syntax highlight ([#33](https://github.com/REditorSupport/vscode-R/issues/33))
* update snippets
* version 0.4.9
* support lint package
* version 0.5.0
* fix lintr issue on windows ([#35](https://github.com/REditorSupport/vscode-R/issues/35))
* return lintr code
* support code region
* version 0.5.1
* little fix
* version 0.5.2
* version 0.5.3
* R term name to R interactive (fix #46) ([#46](https://github.com/REditorSupport/vscode-R/issues/46))
* Send code from Rmd chunk to terminal #49
* version 0.5.4

### Refactor

* refactor
* refactor
* refactor
* refactor
* refactor

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.3.9...v0.5.4>

## 0.3.9 - 2017-07-08

### Bug Fixes

* fix
* fix
* fix lintr

### Other

* Added cursorMove down on line execution
* Don't pass Rterm comments
* Cleaned up skip comments
* Added cursorMove after line execution
* Update extension.ts
* Added cursorMove after line execution ([#13](https://github.com/REditorSupport/vscode-R/issues/13))
* Don't pass Rterm comments ([#14](https://github.com/REditorSupport/vscode-R/issues/14))
* version 0.3.8
* update logo
* version 0.3.9

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.3.7...v0.3.9>

## 0.3.7 - 2017-07-02

### Other

* auto lintr
* version v0.3.7

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.3.6...v0.3.7>

## 0.3.6 - 2017-06-23

### Bug Fixes

* fix
* fix syntax
* fix #7 ([#7](https://github.com/REditorSupport/vscode-R/issues/7))

### Other

* version 0.3.5
* update
* little fix syntax
* version 0.3.6

### Refactor

* refactor

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.3.4...v0.3.6>

## 0.3.4 - 2017-06-17

### Bug Fixes

* fix something

### Other

* clean
* Merge pull request #1 from Ikuyadeu/master
* Fixed typos
* Fixed typos
* Fixed typos
* Fixing typos ([#12](https://github.com/REditorSupport/vscode-R/issues/12))
* use rbox
* version 0.3.1
* version 0.3.4

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.3.1...v0.3.4>

## 0.3.1 - 2017-06-15

### Bug Fixes

* fix #9 ([#9](https://github.com/REditorSupport/vscode-R/issues/9))

### Other

* version 0.3.1

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.3.0...v0.3.1>

## 0.3.0 - 2017-06-09

### Bug Fixes

* fix lintr onMac
* fix lintr output

### Other

* version 0.2.9
* update package
* version 0.3.0

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.2.8...v0.3.0>

## 0.2.8 - 2017-06-04

### Other

* add runSelection/Line
* version 0.2.8

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.2.7...v0.2.8>

## 0.2.7 - 2017-06-04

### Other

* update based project in README.md
* tslint
* set focus #5
* version 0.2.7

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.2.6...v0.2.7>

## 0.2.6 - 2017-06-02

### Bug Fixes

* fix Terminal type
* fix #1 ([#1](https://github.com/REditorSupport/vscode-R/issues/1))
* fix keywords
* fix for windows
* fix
* fix #2 ([#2](https://github.com/REditorSupport/vscode-R/issues/2))

### Other

* update icon
* Create LICENCE
* add license
* version 0.1.8
* add tslint
* setup use lintr
* support lintr
* version 0.2.0
* add install lintr
* version 0.2.1
* Delete vsc-extension-quickstart.md
* version 0.2.2
* add option
* version 0.2.3
* update README.md
* version 0.2.4
* add selectedLine
* version 0.2.5
* add keywords
* Add support for custom encoding (so that UTF-8 scripts can be executed properly)
* Custom encoding support ([#4](https://github.com/REditorSupport/vscode-R/issues/4))
* add lintr term
* update r-snippets.json from atom language-r
* save before Run Source
* update README.md
* version 0.2.6

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.1.3...v0.2.6>

## 0.1.3 - 2017-05-03

### Bug Fixes

* fix perform

### Other

* v0.1.3

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.1.2...v0.1.3>

## 0.1.2 - 2017-04-30

### Bug Fixes

* fix Readme.md

### Other

* update summary in package and readme
* update package.json
* version 0.1.2

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.1.1...v0.1.2>

## 0.1.1 - 2017-04-29

### Bug Fixes

* fix change log
* fix run r perform
* fix for unix os

### Other

* version 0.0.9
* update figure
* support r gitignore
* version 1.1

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.0.8...v0.1.1>

## 0.0.8 - 2017-04-11

### Other

* remove rd-snippets
* add rmd snippets
* version 0.0.8

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.0.7...v0.0.8>

## 0.0.7 - 2017-04-09

### Bug Fixes

* fix readme
* fix readme

### Other

* update document
* update document
* support R Markdown
* version 0.0.7

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.0.6...v0.0.7>

## 0.0.6 - 2017-04-07

### Other

* make create R terminal
* integrated R
* version 0.0.6

**Full Changelog**: <https://github.com/REditorSupport/vscode-R/compare/v0.0.5...v0.0.6>

## 0.0.5 - 2017-04-05

### Bug Fixes

* fix Run .R
* fix test.r
* fix extension's name
* fix summary
* fix publisher

### Other

* init
* add contributes
* update package.json
* add runR
* Update README.md
* createRterm only name
* set multi platform
* Tool to Tools
* update configuration
* add repository
* add feature.png
* Update README.md
* add icon
* update version
* support R doumantation
* version 0.0.3
* add snippets
* version 0.0.4
* support rd-snippets
* version 0.0.5

See [CHANGELOG.old.md](https://github.com/REditorSupport/vscode-R/blob/master/CHANGELOG.old.md) for changes before v2.8.5.

<!-- generated by git-cliff -->
