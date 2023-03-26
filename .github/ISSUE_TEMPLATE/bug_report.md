---
name: Bug report
about: Create a report to help us improve
title: ''
labels: bug
assignees: ''
---

<!-- Is the issue about auto-completion, hover help, go to definition,
  document highlight,  document outline/symbols, workspace symbols, formatting, 
  document link, document color and color picker?
  If so it is more likely an issue with the language server.
  Please report issue at <https://github.com/REditorSupport/languageserver/issues>. -->

**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:

1. Go to '...'
2. Click on '....'
3. Scroll down to '....'
4. See error

**Can you fix this issue by yourself? (We appreciate the help)**

Yes / No

**(If yes,) can we assist you with anything?**

**(If applicable) Please attach `setting.json`**

```jsonc
// R.exe path for windows
"r.rterm.windows": "",

// R path for Mac OS X
"r.rterm.mac": "/usr/local/bin/R",

// R path for Linux
"r.rterm.linux": "/usr/bin/R",

// R command line options (i.e: --vanilla)
"r.rterm.option": [],

// An optional encoding to pass to R when executing the file, i.e. 'source(FILE, encoding=ENCODING)'
"r.source.encoding": "UTF-8",

// Keeping focus when running
"r.source.focus": "editor",

// Use active terminal for all commands, rather than creating a new R terminal
"r.alwaysUseActiveTerminal": false,

// Use bracketed paste mode
"r.bracketedPaste": false,

// Enable R session watcher
"r.sessionWatcher": true,

// Delay in milliseconds before sending each line to rterm (only applies if r.bracketedPaste is false)
"r.rtermSendDelay": 8,
```

**Expected behavior**
A clear and concise description of what you expected to happen.

**Screenshots**
If applicable, add screenshots to help explain your problem.
You can show the keyboard contents by pressing `F1` and `Developer: toggle screencast mode`

**Environment (please complete the following information):**

- OS: [e.g. Windows, macOS, Linux]
- VSCode Version: [e.g. 1.42.0]
- R Version: [e.g. 3.6.2]
- vscode-R version: [e.g. 1.2.2]

**Additional context**
Add any other context about the problem here.
