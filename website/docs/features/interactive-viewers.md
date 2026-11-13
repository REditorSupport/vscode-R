# Interactive viewers

With R session watcher enabled, multiple types of viewers are supported to
display tabular data, graphics, [htmlwidgets](http://www.htmlwidgets.org/) and
[shiny](https://shiny.rstudio.com/) apps.

## Data viewer

`View()` will open a tab to view the object.

| Object type | Viewer |
| --- | --- |
| `data.frame` or `matrix` | paged table viewer |
| [Apache Arrow](https://arrow.apache.org/docs/r/) table | paged table viewer |
| Polars DataFrame | paged table viewer |
| `list` | JSON viewer |
| others, including environments | R code viewer |

### Table viewer

Rows are loaded on demand as you scroll. The table viewer supports sorting,
column filters, row counts, full-value tooltips, and a column panel for
searching, showing, hiding, pinning, and reordering columns. Calling `View()` on
the same object again refreshes the existing tab and preserves its layout when
the column names, order, and types are unchanged.

<img width="1004" alt="image" src="https://user-images.githubusercontent.com/4662568/126723146-24b81ad9-44a8-402c-9d21-381ae36ed112.png">

### List viewer

The list viewer supports collapsing nodes.

<img width="1003" alt="image" src="https://user-images.githubusercontent.com/4662568/126723222-2eb9d3ad-5f80-41ed-a9a1-2b52f156e375.png">

## Plot viewer

The plot viewer supports JGD, httpgd, and a responsive standard SVG/PNG backend.
For more details, go to
[Plot viewer](./plot-viewer.md).

<img width="1267" alt="plot-viewer" src="https://user-images.githubusercontent.com/4662568/122425511-1eaa1480-cfc2-11eb-9d60-f7daab13c1f6.png">

## Webpage viewer

In R, an htmlwidget is written in HTML and can be presented in a web browser.
For example, the following image demonstrates an interactive graphics created by
[plotly](https://plotly.com/r/):

<img width="1266" alt="webpage-viewer" src="https://user-images.githubusercontent.com/4662568/122426000-7ba5ca80-cfc2-11eb-992b-5e467bc828cc.png">

## Browser viewer

Interactive shiny apps can be displayed in VS Code. The following is an example
created by

```r
shiny::runExample("01_hello")
```

<img width="1268" alt="browser-viewer" src="https://user-images.githubusercontent.com/4662568/122426137-9415e500-cfc2-11eb-82f4-c74ce52cef13.png">

For security reasons, the VS Code WebView has security limitations on its
capability of accessing external resources over a network. For more details,
visit
[WebView API](https://code.visualstudio.com/api/extension-guides/webview#security).

If you encounter a problem loading a webpage in a browser viewer, you may try
viewing the web page in an external web browser.

## Help viewer

The web pages in R documentation can be viewed in the help viewer. Syntax
highlighting and link navigation are supported.

Help viewer could be revealed via `?symbol` in R terminal, or from the
[Help pages viewer](./sidebar.md#help-pages-viewer)
in the
[sidebar](./sidebar.md),
or via command `R: Open help for selection` in either command palette or context
menu in the editor.

<img width="1268" alt="help-viewer" src="https://user-images.githubusercontent.com/4662568/122426765-18686800-cfc3-11eb-9e28-a9a7cf1eaa95.png">
