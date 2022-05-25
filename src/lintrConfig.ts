'use strict';

import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { window } from 'vscode';
import { runTextInTerm } from './rTerminal';
import { getCurrentWorkspaceFolder } from './util';

export async function createLintrConfig(): Promise<void> {
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
    void runTextInTerm('lintr::use_lintr()');
}
