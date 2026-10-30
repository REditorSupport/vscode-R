'use strict';

import { rm, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { commands, extensions, window, workspace } from 'vscode';

import { runTextInTerm } from './rTerminal';
import { getWordOrSelection } from './selection';
import {
    config,
    checkForSpecialCharacters,
    delay,
    createTempDir,
    getCurrentWorkspaceFolder,
    ToRStringLiteral,
} from './util';

export async function previewEnvironment(): Promise<void> {
    if (config().get('sessionWatcher')) {
        await runTextInTerm('View(globalenv())');
    } else {
        if (!(await checkcsv())) {
            return;
        }
        const currentWorkspaceFolder = getCurrentWorkspaceFolder()?.uri.fsPath;
        if (!currentWorkspaceFolder) {
            return;
        }
        const tmpDir = createTempDir(currentWorkspaceFolder, true);
        const pathToTmpCsv = join(tmpDir, 'environment.csv');
        const envName = 'name=ls()';
        const envClass =
            'class=sapply(ls(), function(x) {class(get(x, envir = parent.env(environment())))[1]})';
        const envOut =
            'out=sapply(ls(), function(x) {capture.output(str(get(x, envir = parent.env(environment()))), silent = T)[1]})';
        const rWriteCsvCommand =
            'write.csv(data.frame(' +
            `${envName},` +
            `${envClass},` +
            `${envOut}), ` +
            `${ToRStringLiteral(pathToTmpCsv, '"')}, row.names=FALSE, quote = TRUE)`;
        await writeAndOpenTmpCSV(rWriteCsvCommand, pathToTmpCsv, tmpDir);
    }
}

export async function previewDataframe(): Promise<boolean | undefined> {
    if (config().get('sessionWatcher')) {
        const symbol = getWordOrSelection();
        await runTextInTerm(`View(${symbol || 'undefined'})`);
    } else {
        if (!(await checkcsv())) {
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
        const pathToTmpCsv = join(tmpDir, `${dataframeName}.csv`);
        const rWriteCsvCommand = `write.csv(${dataframeName}, ${ToRStringLiteral(pathToTmpCsv, '"')}, row.names = FALSE, quote = FALSE)`;
        await writeAndOpenTmpCSV(rWriteCsvCommand, pathToTmpCsv, tmpDir);
    }
}

async function writeAndOpenTmpCSV(
    command: string,
    pathToTmpCsv: string,
    tmpDir: string,
): Promise<false | undefined> {
    try {
        const submitted = await runTextInTerm(
            `base::invisible({ ${command}; base::file.create(${ToRStringLiteral(`${pathToTmpCsv}.ready`, '"')}) })`,
        );
        if (!submitted) {
            return false;
        }
        // R may be busy before it starts writing. A completion marker avoids both
        // a fixed startup delay and mistaking a temporarily stable file for a full CSV.
        const deadline = Date.now() + 30000;
        let ready = false;
        while (Date.now() < deadline) {
            ready = await access(`${pathToTmpCsv}.ready`).then(
                () => true,
                () => false,
            );
            if (ready) {
                break;
            }
            await delay(50);
        }
        if (!ready) {
            void window.showErrorMessage(
                'Dataframe failed to display: R did not finish writing the CSV within 30 seconds.',
            );
            return false;
        }
        if ((await stat(pathToTmpCsv)).size > 20 * 1000000) {
            void window.showWarningMessage('The CSV preview supports files up to 20 MB.');
            return false;
        }
        const file = await workspace.openTextDocument(pathToTmpCsv);
        await commands.executeCommand('csv.preview', file.uri);
    } catch (error) {
        void window.showErrorMessage(`Dataframe failed to display: ${String(error)}`);
        return false;
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
}

async function checkcsv(): Promise<boolean> {
    const iscsv = extensions.getExtension('GrapeCity.gc-excelviewer');
    if (iscsv !== undefined) {
        try {
            await iscsv.activate();
            return true;
        } catch (error) {
            void window.showErrorMessage(`Could not activate the CSV viewer: ${String(error)}`);
            return false;
        }
    }
    void window
        .showInformationMessage(
            'This function need to install `GrapeCity.gc-excelviewer`, will you install?',
            'Yes',
            'No',
        )
        .then((select) => {
            if (select === 'Yes') {
                void commands.executeCommand(
                    'workbench.extensions.installExtension',
                    'GrapeCity.gc-excelviewer',
                );
            }
        });

    return false;
}
