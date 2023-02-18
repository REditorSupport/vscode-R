'use strict';

import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { window } from 'vscode';
import { executeRCommand, getCurrentWorkspaceFolder } from './util';

export async function createLintrConfig(): Promise<string | undefined> {
    const currentWorkspaceFolder = getCurrentWorkspaceFolder()?.uri.fsPath;
    if (currentWorkspaceFolder === undefined) {
        void window.showWarningMessage('Please open a workspace folder to create .lintr');
        return;
    }
    const lintrFilePath = join(currentWorkspaceFolder, '.lintr');
    if (existsSync(lintrFilePath)) {
        const overwrite = await window.showWarningMessage(
            '".lintr" file already exists. Do you want to overwrite?',
            'Yes', 'No'
        );
        if (overwrite === 'No') {
            return;
        }
        void unlinkSync(lintrFilePath);
    }
    return await executeRCommand(`lintr::use_lintr()`, currentWorkspaceFolder, (e: Error) => {
        void window.showErrorMessage(e.message);
        return '';
    });
}
