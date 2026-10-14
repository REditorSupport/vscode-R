'use strict';

import { writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { window } from 'vscode';
import { extensionContext } from './extension';
import { catchAsError, getCurrentWorkspaceFolder } from './util';

export async function createGitignore(): Promise<void> {
    // .gitignore template from "https://github.com/github/gitignore/blob/main/R.gitignore"
    const ignoreFileTemplate = extensionContext.asAbsolutePath('R/template/R.gitignore');
    const ignoreFileContent = readFileSync(ignoreFileTemplate);

    const currentWorkspaceFolder = getCurrentWorkspaceFolder()?.uri.fsPath;
    if (currentWorkspaceFolder === undefined) {
        void window.showWarningMessage('Please open a workspace folder to create .gitignore');
        return;
    }
    const ignorePath = join(currentWorkspaceFolder, '.gitignore');
    if (existsSync(ignorePath)) {
        const overwrite = await window.showWarningMessage(
            '".gitignore" file already exists. Do you want to overwrite?',
            'Yes', 'No'
        );
        if (overwrite !== 'Yes') {
            return;
        }
    }
    try {
        await writeFile(ignorePath, ignoreFileContent);
    } catch (e) {
        void window.showErrorMessage(catchAsError(e).message);
    }
}
