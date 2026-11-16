# R Extension for Visual Studio Code

<!-- badges: start -->

<a href="https://reditorsupport.github.io/vscode-R/"><img src="https://img.shields.io/badge/docs-website-blue" alt="Documentation"></a>
<a href="https://marketplace.visualstudio.com/items?itemName=REditorSupport.r"><img src="https://img.shields.io/badge/VS%20Code%20Marketplace-install-007ACC" alt="VS Code Marketplace"></a>
<a href="https://open-vsx.org/extension/REditorSupport/r"><img src="https://img.shields.io/badge/Open%20VSX-install-C160EF" alt="Open VSX Registry"></a>

<!-- badges: end -->

This [VS Code](https://code.visualstudio.com/) extension provides support for the [R programming language](https://www.r-project.org), including an R language service based on code analysis, interaction with R terminals, viewers for data, plots, workspace variables, and help pages, package management, and [R Markdown](https://rmarkdown.rstudio.com/) support.

**Documentation: <https://reditorsupport.github.io/vscode-R/>**

See [Getting Started](https://reditorsupport.github.io/vscode-R/getting-started) for an overview, and the installation guides for [Windows](https://reditorsupport.github.io/vscode-R/installation/windows), [macOS](https://reditorsupport.github.io/vscode-R/installation/macos), and [Linux](https://reditorsupport.github.io/vscode-R/installation/linux) for detailed setup instructions.

## Quickstart

1. [Install R](https://cloud.r-project.org/) (>= 3.4.0).

2. Install the [languageserver](https://github.com/REditorSupport/languageserver) package from R.

    ```r
    install.packages("languageserver")
    ```

3. Install this extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) or the [Open VSX Registry](https://open-vsx.org/extension/REditorSupport/r). It requires VS Code 1.101.0 or later.

4. Create an R file and start coding! (Click **Yes** if prompted to install sess.)

Daily pre-releases are also available: choose **Switch to Pre-Release Version** on the extension's page in VS Code. See [release channels](https://reditorsupport.github.io/vscode-R/getting-started#release-channels) for details and development builds.

## Questions, bug reports, ideas, and contributions

* If you have a question, need help with setup or troubleshooting, or are unsure whether you have found a bug, please [start a Q&A discussion](https://github.com/REditorSupport/vscode-R/discussions/new?category=q-a).

* If you have an idea for a new feature or behavior change, please [start an Ideas discussion](https://github.com/REditorSupport/vscode-R/discussions/new?category=ideas).

* If you find a reproducible problem with the extension, please [check the existing issues](https://github.com/REditorSupport/vscode-R/issues) and then [file a bug report](https://github.com/REditorSupport/vscode-R/issues/new/choose). Include the extension version and reproduction steps.

* Contributions are always welcome! Please see the [contributing guide](https://reditorsupport.github.io/vscode-R/contributing) for more details.

The R and R Markdown syntaxes are located in a sibling package, [vscode-R-syntax](https://github.com/REditorSupport/vscode-R-syntax). See the [changelog](https://github.com/REditorSupport/vscode-R/blob/main/CHANGELOG.md) for changes in each release.
