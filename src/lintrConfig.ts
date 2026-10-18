'use strict';

import { existsSync, mkdtempSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import { window } from 'vscode';
import { catchAsError, executeRCommand, getCurrentWorkspaceFolder } from './util';

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
            'Yes',
            'No',
        );
        if (overwrite !== 'Yes') {
            return;
        }
    }

    let backupDirectory: string | undefined;
    let generated = false;
    try {
        if (existsSync(lintrFilePath)) {
            // lintr refuses to overwrite an existing file. Keep the original on
            // disk until it has successfully generated the replacement.
            backupDirectory = mkdtempSync(join(currentWorkspaceFolder, '.vscode-r-lintr-'));
            renameSync(lintrFilePath, join(backupDirectory, '.lintr'));
        }
        const output = await executeRCommand(
            'lintr::use_lintr()',
            currentWorkspaceFolder,
            (error: Error) => {
                throw error;
            },
        );
        if (output !== undefined) {
            if (!existsSync(lintrFilePath)) {
                throw new Error('R did not create a .lintr configuration.');
            }
            generated = true;
        }
        return output;
    } catch (error) {
        void window.showErrorMessage(catchAsError(error).message);
        return '';
    } finally {
        if (backupDirectory) {
            const backupPath = join(backupDirectory, '.lintr');
            if (!generated && existsSync(backupPath)) {
                renameSync(backupPath, lintrFilePath);
            }
            rmSync(backupDirectory, { recursive: true, force: true });
        }
    }
}
