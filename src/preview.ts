'use strict';

import { removeSync, statSync } from 'fs-extra';
import { commands, extensions, window, workspace } from 'vscode';

import { runTextInTerm } from './rTerminal';
import { getWordOrSelection } from './selection';
import { config, checkForSpecialCharacters, checkIfFileExists, delay, createTempDir, getCurrentWorkspaceFolder } from './util';

export async function previewEnvironment(): Promise<void> {
    if (config().get('sessionWatcher')) {
        await runTextInTerm('View(globalenv())');
    } else {
        if (!checkcsv()) {
            return;
        }
        const currentWorkspaceFolder = getCurrentWorkspaceFolder()?.uri.fsPath;
        if (!currentWorkspaceFolder) {
            return;
        }
        const tmpDir = createTempDir(currentWorkspaceFolder, true);
        const pathToTmpCsv = `${tmpDir}/environment.csv`;
        const envName = 'name=ls()';
        const envClass = 'class=sapply(ls(), function(x) {class(get(x, envir = parent.env(environment())))[1]})';
        const envOut = 'out=sapply(ls(), function(x) {capture.output(str(get(x, envir = parent.env(environment()))), silent = T)[1]})';
        const rWriteCsvCommand = 'write.csv(data.frame('
            + `${envName},`
            + `${envClass},`
            + `${envOut}), '`
            + `${pathToTmpCsv}', row.names=FALSE, quote = TRUE)`;
        await runTextInTerm(rWriteCsvCommand);
        await openTmpCSV(pathToTmpCsv, tmpDir);
    }
}

export async function previewDataframe(): Promise<boolean | undefined> {
    if (config().get('sessionWatcher')) {
        const symbol = getWordOrSelection();
        await runTextInTerm(`View(${symbol || 'undefined'})`);
    } else {
        if (!checkcsv()) {
            return;
        }
        const currentWorkspaceFolder = getCurrentWorkspaceFolder()?.uri.fsPath;
        if (!currentWorkspaceFolder) {
            return;
        }

        const dataframeName = getWordOrSelection();
        if (!dataframeName) {
            return;
        }

        if (!checkForSpecialCharacters(dataframeName)) {
            void window.showInformationMessage('This does not appear to be a dataframe.');

            return false;
        }

        const tmpDir = createTempDir(currentWorkspaceFolder, true);

        // Create R write CSV command.  Turn off row names and quotes, they mess with Excel Viewer.
        const pathToTmpCsv = `${tmpDir}/${dataframeName}.csv`;
        const rWriteCsvCommand = `write.csv(${dataframeName}, `
            + `'${pathToTmpCsv}', row.names = FALSE, quote = FALSE)`;
        await runTextInTerm(rWriteCsvCommand);
        await openTmpCSV(pathToTmpCsv, tmpDir);
    }
}

async function openTmpCSV(pathToTmpCsv: string, tmpDir: string): Promise<false | undefined> {
    await delay(350); // Needed since file size has not yet changed

    if (!checkIfFileExists(pathToTmpCsv)) {
        void window.showErrorMessage('Dataframe failed to display.');
        removeSync(tmpDir);

        return false;
    }

    // Async poll for R to complete writing CSV.
    const success = await waitForFileToFinish(pathToTmpCsv);
    if (!success) {
        void window.showWarningMessage('Visual Studio Code currently limits opening files to 20 MB.');
        removeSync(tmpDir);

        return false;
    }

    // Open CSV in Excel Viewer and clean up.
    void workspace.openTextDocument(pathToTmpCsv).then(
        async (file) => {
            await commands.executeCommand('csv.preview', file.uri);
            removeSync(tmpDir);
        }
    );
}

async function waitForFileToFinish(filePath: string): Promise<boolean | undefined> {
    const fileBusy = true;
    let currentSize = 0;
    let previousSize = 1;

    while (fileBusy) {
        const stats = statSync(filePath);
        currentSize = stats.size;

        // UPDATE: We are now limited to 20 mb by MODEL_TOKENIZATION_LIMIT
        // Https://github.com/Microsoft/vscode/blob/master/src/vs/editor/common/model/textModel.ts#L34
        if (currentSize > 2 * 10000000) { // 20 MB
            return false;
        }

        if (currentSize === previousSize) {
            return true;
        }
        previousSize = currentSize;
        await delay(50);
    }
}

function checkcsv(): boolean {
    const iscsv = extensions.getExtension('GrapeCity.gc-excelviewer');
    if (iscsv !== undefined && iscsv.isActive) {
        return true;
    }
    void window.showInformationMessage(
        'This function need to install `GrapeCity.gc-excelviewer`, will you install?',
        'Yes',
        'No'
    ).then((select) => {
        if (select === 'Yes') {
            void commands.executeCommand('workbench.extensions.installExtension', 'GrapeCity.gc-excelviewer');
        }
    });

    return false;
}
