import { workspace, window } from 'vscode';
import fs = require('fs');
import path = require('path');
const ignorePath =  path.join(workspace.rootPath, '.gitignore');
// From 'https://github.com/github/gitignore/raw/master/R.gitignore'
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
                   "*.knit.md"].join('\n');

export function createGitignore() {
    if (!workspace.rootPath) {
        window.showWarningMessage('Please open workspace to create .gitignore');
        return;
    }
    fs.writeFile(ignorePath, ignoreFiles, (err) => {
        try {
            if (err) {
                console.log(err);
            }
        } catch (e) {
            window.showErrorMessage(e.message);
        }
    });
}