'use strict';

import { writeFile } from 'fs-extra';
import { existsSync } from 'fs';
import { join } from 'path';
import { window, workspace } from 'vscode';
// .gitignore template from "https://github.com/github/gitignore/blob/main/R.gitignore"
const ignoreFiles = ['# History files',
    '.Rhistory',
    '.Rapp.history',
    '',
    '# Session Data files',
    '.RData',
    '.RDataTmp',
    '',
    '# User-specific files',
    '.Ruserdata',
    '',
    '# Example code in package build process',
    '*-Ex.R',
    '',
    '# Output files from R CMD build',
    '/*.tar.gz',
    '',
    '# Output files from R CMD check',
    '/*.Rcheck/',
    '',
    '# RStudio files',
    '.Rproj.user/',
    '',
    '# produced vignettes',
    'vignettes/*.html',
    'vignettes/*.pdf',
    '',
    '# OAuth2 token, see https://github.com/hadley/httr/releases/tag/v0.3',
    '.httr-oauth',
    '',
    '# knitr and R markdown default cache directories',
    '*_cache/',
    '/cache/',
    '',
    '# Temporary files created by R markdown',
    '*.utf8.md',
    '*.knit.md',
    '',
    '# R Environment Variables',
    '.Renviron',
    '',
    '# pkgdown site',
    'docs/',
    '',
    '# translation temp files',
    'po/*~',
    '',
    '# RStudio Connect folder',
    'rsconnect/',
    ''].join('\n');

export async function createGitignore(): Promise<void> {
    if (workspace.workspaceFolders[0].uri.path === undefined) {
        void window.showWarningMessage('Please open workspace to create .gitignore');

        return;
    }
    const ignorePath = join(workspace.workspaceFolders[0].uri.path, '.gitignore');
    if (existsSync(ignorePath)) {
        const override = await window.showWarningMessage(
            '".gitignore" file is already exist. Do you want to override?',
            'Yes', 'No'
        );
        if (override === 'No') {
            return;
        }
    }
    writeFile(ignorePath, ignoreFiles, (err) => {
        try {
            if (err) {
                void window.showErrorMessage(err.name);
            }
        } catch (e) {
            void window.showErrorMessage(e);
        }
    });
}
