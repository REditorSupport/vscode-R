---
name: Bug report
about: Create a report to help us improve
title: ''
labels: bug
assignees: ''

---

**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Go to '...'
2. Click on '....'
3. Scroll down to '....'
4. See error

**Do you want to fix by self? (I hope your help!)**

Yes / No

**(If yes,) what kind of help do you want? (e.g. Which file should I fix, Survey (related documents)**

(If related)setting.json

```json
// R.exe path for windows
"r.rterm.windows": "C:\\Program Files\\R\\R-3.4.4\\bin\\x64\\R.exe",

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

// Enable R session watcher (experimental)
"r.sessionWatcher": false,
```

**Expected behavior**
A clear and concise description of what you expected to happen.

**Screenshots**
If applicable, add screenshots to help explain your problem.
You can show the keybord contents by pressing `F1` and `Developer: toggle screencast mode`

**Environment (please complete the following information):**
 - OS: [e.g. iOS]
 - VSCode Version [e.g. 22]
 - R Version

**Additional context**
Add any other context about the problem here.
