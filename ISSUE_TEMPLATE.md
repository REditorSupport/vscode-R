<!-- Use Help > Report Issues to prefill these. -->
- VSCode Version:
- VSCode-R Version:
- OS Version:

Steps to Reproduce:

1. 
1. 

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

// Enable lintr
"r.lintr.enabled": true,

// list of linter functions
"r.lintr.linters": "default_linters",

// toggle caching of lint results
"r.lintr.cache": true,

// R executable path for lintr
"r.lintr.executable": "",

// If true, lintr exec lint_package() instead of lint()
"r.lintr.ispackage": false
```
