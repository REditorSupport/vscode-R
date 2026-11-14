# Keyboard shortcuts

To learn how to edit your keybindings, see [Keyboard shortcuts for Visual Studio Code](https://code.visualstudio.com/docs/configure/keybindings).

The easiest way to edit your keybindings is to open the Keyboard Shortcuts editor with `ctrl+k ctrl+s` (or `⌘K ⌘S` on macOS) and then click the icon in the top right corner to open and edit the `keybindings.json` file directly.

## Suggested keyboard shortcuts

If you have used RStudio, you may want to add some of these keyboard shortcuts to your
`keybindings.json` file to make your experience more similar.

```json
[
      // Restart R terminal
  {
   "key": "ctrl+shift+f10",
   "command": "runCommands",
   "args": {
       "commands": [
           {
               "command": "workbench.action.terminal.kill",
               "when": "editorTextFocus && editorLangId == 'r' || editorTextFocus && editorLangId == 'rmd'"
           },
           {
               "command": "r.createRTerm"
           }
       ]
   }
  },
  {
    "key": "alt+-",
    "command": "type",
    "when": "editorLangId == r && editorTextFocus || editorLangId == rmd && editorTextFocus",
    // if you want using quarto, try this
    // "when": "editorLangId =~ /r|rmd|qmd/ && editorTextFocus",
    "args": {"text": " <- "}
  },
  {
    "key": "ctrl+shift+m",
    "command": "type",
    "when": "editorLangId == r && editorTextFocus || editorLangId == rmd && editorTextFocus",
    "args": {"text": " %>% "}
  },
  {
    "key": "ctrl+shift+m",
    "command": "-workbench.actions.view.problems"
  },

  // input indicative of r markdown code chunk
  {
    "key": "ctrl+shift+i",
    "command": "editor.action.insertSnippet",
    "when": "editorTextFocus && editorLangId == 'rmd'",
    "args": {
        "snippet": "```{r}\n${TM_SELECTED_TEXT}$0\n```"
    },
    "label": "input indicative of r markdown code chunk"
  },

  // you can also input indicative of code chunk in `r` file by inserting "# %% ":
  // specifics in `https://github.com/REditorSupport/vscode-R/pull/662`
  {
    "key": "ctrl+shift+i",
    "command": "editor.action.insertSnippet",
    "when": "editorTextFocus && editorLangId == 'r'",
    "args": {
        "snippet": "$LINE_COMMENT %% "
    },
    "label": "input indicative of code chunk"
  },

  // open help panel for selection
  {
    "key": "f1",
    "command": "r.helpPanel.openForSelection",
    "when": "editorTextFocus && editorLangId == 'r' || editorTextFocus && editorLangId == 'rmd'"
  },

  // RStudio keybinding for R Package development
  {
    "key": "ctrl+shift+b",
    "command": "r.install",
    "when": "resourceLangId == 'r'"
  },
  {
    "key": "ctrl+shift+e",
    "command": "r.check",
    "when": "resourceLangId == 'r'"
  },
  {
    "key": "ctrl+shift+t",
    "command": "r.test",
    "when": "resourceLangId == 'r'"
  },
  {
    "key": "ctrl+shift+d",
    "command": "r.document",
    "when": "resourceLangId == 'r'"
  },
  {
    "key": "ctrl+shift+l",
    "command": "r.loadAll",
    "when": "resourceLangId == 'r'"
  }
]

```

## Removed keyboard shortcuts

These keyboard shortcuts used to be set by this extension, but were removed
because they conflicted with default Visual Studio Code shortcuts. If you would
like to restore them, add these to `keybindings.json`:

```json
[
  {
    "command": "r.nrow",
    "key": "Ctrl+1",
    "when": "editorTextFocus && editorLangId == 'r'"
  },
  {
    "command": "r.length",
    "key": "Ctrl+2",
    "when": "editorTextFocus && editorLangId == 'r'"
  },
  {
    "command": "r.head",
    "key": "Ctrl+3",
    "when": "editorTextFocus && editorLangId == 'r'"
  },
  {
    "command": "r.thead",
    "key": "Ctrl+4",
    "when": "editorTextFocus && editorLangId == 'r'"
  },
  {
    "command": "r.names",
    "key": "Ctrl+5",
    "when": "editorTextFocus && editorLangId == 'r'"
  }
]
```

## Creating keybindings for R commands

There are 3 ways you can use extension functions to create keybindings that run
R commands in the terminal:

1. `r.runCommand` to make a keybinding to run any R expression.
2. `r.runCommandWithEditorPath` to create a keybinding for an R expression where
   the placeholder value `$$` is interpolated with the current file path.
3. `runCommandWithSelectionOrWord` to create a keybinding for an R expression
   where `$$` is interpolated with the current selection or the current word the
   cursor is on.

Here are some example entries from `keybindings.json`:

```json
[
  {
    "description": "run drake::r_make()",
    "key": "ctrl+;",
    "command": "r.runCommand",
    "when": "editorTextFocus",
    "args": "drake::r_make()"
  },
  {
    "description": "load drake target at cursor",
    "key": "ctrl+shift+;",
    "command": "r.runCommandWithSelectionOrWord",
    "when": "editorTextFocus",
    "args": "drake::loadd($$)"
  },
  {
    "description": "knit to html",
    "key": "ctrl+i",
    "command": "r.runCommandWithEditorPath",
    "when": "editorTextFocus",
    "args": "rmarkdown::render(\"$$\", output_format = rmarkdown::html_document(), output_dir = \".\", clean = TRUE)"
  }
]
```
