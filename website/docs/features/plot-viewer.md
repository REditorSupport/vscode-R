# Plot viewer

Plots from an attached R session can be displayed in a VS Code editor tab. Use
`r.plot.backend` to select one of four modes:

- `auto` (default): use JGD if installed, otherwise httpgd if installed,
  otherwise the standard viewer
- `jgd`: use the [JGD](https://github.com/REditorSupport/jgd) graphics device
- `httpgd`: use the [httpgd](https://github.com/nx10/httpgd) graphics device
- `standard`: use the built-in responsive plot viewer

Backend changes take effect without reloading VS Code. vscode-R warns and falls
back when the requested package is unavailable.

JGD is lightweight, has no external R-package dependencies, and is usually
simpler to install. httpgd has a mature, feature-rich SVG viewer, but a larger
compiled dependency footprint. If you are unsure which optional backend to
install, start with JGD.

## Standard viewer

The standard backend records the current R plot and re-renders it to fit the
viewer whenever the panel is resized. It uses crisp SVG output when the
`svglite` R package is installed and falls back to PNG otherwise.

Use `r.plot.format` to request `"svglite"` or `"png"`. The
`r.plot.devArgs` setting supplies additional graphics-device arguments, but the
responsive viewer manages width and height itself.

To use R's native graphics window instead, disable the session watcher with
`r.sessionWatcher`. This also disables the other features that require an
attached R session.

## JGD viewer

Install the `jgd` R package to use the lightweight JGD backend:

```r
install.packages("jgd")
```

JGD supports plot history, navigation, zoom, and export. Configure the maximum
history size with `r.plot.jgd.historyLimit`, and the default export dimensions
and resolution with `r.plot.jgd.exportWidth`, `r.plot.jgd.exportHeight`, and
`r.plot.jgd.exportDpi`.

## httpgd viewer

Install `httpgd` to use its SVG-based interactive viewer:

```r
install.packages("httpgd")
```

Select it explicitly with `"r.plot.backend": "httpgd"`, or leave the backend
as `auto`. The viewer supports resizing, themes, plot history, hiding, zooming,
and export.

<img width="916" alt="plot viewer" src="https://user-images.githubusercontent.com/4662568/122624181-974bc680-d0d1-11eb-99a9-59a34e105ad8.png">
