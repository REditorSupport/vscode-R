# R Markdown

R Markdown document creation is supported with the following features:

- Chunk highlighting
- Chunk navigation commands (Select current chunk, go to previous/next chunks,
  etc.)
- Chunk execution commands (Run current chunk, run above/below chunks, etc.)
- Automatic evaluation of YAML `params` before running code
- Rmd render commands (Knit, Knit to PDF/HTML/All)
- Live preview rmd (as html)
- Create new draft from a template

## File association

By default, `Rmd` files are open as Markdown documents. To enable R Markdown features, you need to associate `*.Rmd` files with `rmd` language. Add an entry Item `*.Rmd` and Value `rmd` in the VS Code settings editor:

<img width="848" alt="image" src="https://user-images.githubusercontent.com/4662568/161364066-996eac59-e3c1-400a-a382-ec90fca2a9f0.png">

or directly update `settings.json` with the following:

```json
{
   "files.associations": {
     "*.Rmd": "rmd"
  }
}
```

## Installing pandoc

[pandoc](https://pandoc.org) is required to render R Markdown documents. Visit [Installing pandoc](https://pandoc.org/installing.html) for instructions.

You may need to restart VS Code for `rmarkdown` to be able to detect `pandoc`.

## Editing R Markdown documents

![Kapture 2020-10-28 at 22 25 08](https://user-images.githubusercontent.com/4662568/97449414-99a7b780-196c-11eb-9d2e-2c8eb5804d54.gif)

When an R Markdown document declares `params` in its YAML header, vscode-R
evaluates them into the R session before running code from the document. A
custom shortcut to load the parameters is not required.

## Knitting R Markdown documents

R Markdown documents can be knit in a VSCode-R managed background process when
using the knit command. Beyond the use of a background process, this has the
following features:

- Set knitr document directory
- Knit progress tracking
- Smart knitting

### Set knitr document directory

By default, knitr evaluates documents as though they are the root folder. For
instance, calling `source` in a document will use the document's folder as the
working directory, not the document's workspace. This can be modified in
VSCode-R, so as to tell knitr if we want to evaluate from the workspace root or
the document directory.

![setDirectory](https://user-images.githubusercontent.com/60372411/132448957-ce47a04d-60e6-4a94-a914-fd9422927a35.png)

### Progress tracking

Knit progress is tracked via a progress bar, and can be viewed in the R Markdown
output stream. Progress is determined by the percentages reported in the R
Markdown output stream and may not be 100% accurate.

![image](https://user-images.githubusercontent.com/60372411/132447538-26ef1046-b530-449b-ac61-25d354ae4afb.png)

### Smart knitting

The knit button is "smart" in that it checks the document and its workspace for
context when knitting. For instance, if a document has a knit function defined
in the YAML header, the knit button will call the custom function when knitting.
This also works for R Markdown sites, where the knit button will call
`rmarkdown::render_site` instead of `rmarkdown::render`.

## Live rendering R Markdown documents

You can live preview R Markdown documents by pressing the "Open Preview to Side"
button when focused on an R Markdown document.

![preview](https://user-images.githubusercontent.com/60372411/132450498-1c5fae22-6a51-4eb4-9815-08bd29a52a13.png)

You can also preview a document by right-clicking it in the explorer and
selecting preview.

You can also run the following code and a browser viewer will open with live
rendering of the R Markdown document.

```r
rmarkdown::run("your-rmd-document.Rmd")
```

## Live previewing rendered R Markdown documents

When an R Markdown document is knit and rendered to an HTML file, [Live Preview](https://marketplace.visualstudio.com/items?itemName=ms-vscode.live-server) can be used to live preview the HTML document. It supports auto-refresh when the HTML file is updated.

## Templates

You can run "R Markdown: New Draft" from the command palettes to create a new draft from an R Markdown template.

The following is a (incomplete) list of packages that provide R Markdown templates:

* [rmarkdown](https://rmarkdown.rstudio.com/gallery.html)
* [rticles](https://pkgs.rstudio.com/rticles/index.html)
* [tufte](https://rstudio.github.io/tufte/)
* [prettydoc](https://prettydoc.statr.me/)
