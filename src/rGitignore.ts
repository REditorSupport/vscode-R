'use strict';

import { writeFile } from 'fs-extra';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { window, workspace } from 'vscode';
import { extensionContext } from './extension';
// .gitignore template from "https://github.com/github/gitignore/blob/main/R.gitignore"
const ignoreFileTemplate = extensionContext.asAbsolutePath('R/template/R.gitignore');
const ignoreFileContent = readFileSync(ignoreFileTemplate);

export async function createGitignore(): Promise<void> {
    if (workspace.workspaceFolders[0].uri.path === undefined) {
        void window.showWarningMessage('Please open workspace to create .gitignore');

        return;
    }
    const ignorePath = join(workspace.workspaceFolders[0].uri.path, '.gitignore');
    if (existsSync(ignorePath)) {
        const overwrite = await window.showWarningMessage(
            '".gitignore" file is already exist. Do you want to overwrite?',
            'Yes', 'No'
        );
        if (overwrite === 'No') {
            return;
        }
    }
    writeFile(ignorePath, ignoreFileContent, (err) => {
        try {
            if (err) {
                void window.showErrorMessage(err.name);
            }
        } catch (e) {
            void window.showErrorMessage(e);
        }
    });
}
