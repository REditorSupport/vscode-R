"use strict";

import { writeFile } from "fs-extra";
import { join } from "path";
import {  window, workspace } from "vscode";
// From "https://github.com/github/gitignore/raw/master/R.gitignore"
const ignoreFiles = [".Rhistory",
                     ".Rapp.history",
                     ".RData",
                     "*-Ex.R",
                     "/*.tar.gz",
                     "/*.Rcheck/",
                     ".Rproj.user/",
                     "vignettes/*.html",
                     "vignettes/*.pdf",
                     ".httr-oauth",
                     "/*_cache/",
                     "/cache/",
                     "*.utf8.md",
                     "*.knit.md",
                     "rsconnect/"].join("\n");

export function createGitignore() {
    if (workspace.workspaceFolders[0].uri.path === undefined) {
        window.showWarningMessage("Please open workspace to create .gitignore");

        return;
    }
    const ignorePath = join(workspace.workspaceFolders[0].uri.path, ".gitignore");
    writeFile(ignorePath, ignoreFiles, (err) => {
        try {
            if (err) {
                window.showErrorMessage(err.name);
            }
        } catch (e) {
            window.showErrorMessage(e.message);
        }
    });
}
