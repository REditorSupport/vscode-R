'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { Uri, window } from 'vscode';
import {
    getRpath,
    getCurrentWorkspaceFolder,
    executeRCommand,
    createTempDir,
    spawnAsync,
    ToRStringLiteral,
} from './util';
import { extensionContext } from './extension';

export async function generateCppProperties(): Promise<void> {
    const currentWorkspaceFolder = getCurrentWorkspaceFolder()?.uri.fsPath;
    if (currentWorkspaceFolder === undefined) {
        void window.showWarningMessage(
            'Please open a workspace folder to create c_cpp_properties.json',
        );
        return;
    }
    const outFilePath = path.join(currentWorkspaceFolder, '.vscode', 'c_cpp_properties.json');
    if (fs.existsSync(outFilePath)) {
        const overwrite = await window.showWarningMessage(
            '"c_cpp_properties.json" file already exists. Do you want to overwrite?',
            'Yes',
            'No',
        );
        if (overwrite !== 'Yes') {
            return;
        }
    }
    return generateCppPropertiesProc(currentWorkspaceFolder);
}

/** Helper: Return object depending on current process platform */
function platformChoose<A, B, C>(win32: A, darwin: B, other: C): A | B | C {
    return process.platform === 'win32' ? win32 : process.platform === 'darwin' ? darwin : other;
}

// See: https://code.visualstudio.com/docs/cpp/c-cpp-properties-schema-reference
async function generateCppPropertiesProc(workspaceFolder: string) {
    const rPath = await getRpath(false, Uri.file(workspaceFolder));
    if (!rPath) {
        return;
    }

    // Collect information from running the compiler
    const configureFile = platformChoose('configure.win', 'configure', 'configure');
    const cleanupFile = platformChoose('cleanup.win', 'cleanup', 'cleanup');

    if (fs.existsSync(path.join(workspaceFolder, configureFile))) {
        await executeRCommand(`system("sh ./${configureFile}")`, workspaceFolder, (e: Error) => {
            void window.showErrorMessage(e.message);
            return '';
        });
    }

    let compileOutputCpp: string;
    let compileOutputC: string;
    try {
        compileOutputCpp = await collectCompilerOutput(rPath, workspaceFolder, 'cpp');
        compileOutputC = await collectCompilerOutput(rPath, workspaceFolder, 'c');
    } finally {
        if (fs.existsSync(path.join(workspaceFolder, cleanupFile))) {
            await executeRCommand(`system("sh ./${cleanupFile}")`, workspaceFolder, (e: Error) => {
                void window.showErrorMessage(e.message);
                return '';
            });
        }
    }

    const compileInfo = extractCompilerInfo(compileOutputCpp);
    const compileStdCpp = extractCompilerStd(compileOutputCpp);
    const compileStdC = extractCompilerStd(compileOutputC);
    const compileCall = extractCompilerCall(compileOutputCpp);
    const compilerPath = compileCall
        ? await executeRCommand(
              `cat(Sys.which(${ToRStringLiteral(compileCall, '"')}))`,
              workspaceFolder,
              (e: Error) => {
                  void window.showErrorMessage(e.message);
                  return '';
              },
          )
        : '';

    const intelliSensePlatform = platformChoose('windows', 'macos', 'linux');
    const intelliSenseComp = compileCall
        ? compileCall.includes('clang')
            ? 'clang'
            : 'gcc'
        : 'gcc';
    const intelliSense = `${intelliSensePlatform}-${intelliSenseComp}-${process.arch}`;

    // Collect information from 'DESCRIPTION'
    const linkingToIncludes = await collectRLinkingTo(workspaceFolder);

    // Combine information
    const envIncludes: string[] = ['${workspaceFolder}/src'];
    envIncludes.push(
        ...compileInfo.compIncludes.map((v) =>
            path.isAbsolute(v) ? v : `\${workspaceFolder}/${path.join('src', v)}`,
        ),
    );
    envIncludes.push(...linkingToIncludes);

    const envDefines = compileInfo.compDefines;

    // If no standard is set on linux, the C standard seems to default to the c++ one.
    const envCStd = !compileStdC || compileStdC.includes('++') ? '${default}' : compileStdC;

    const platformName = platformChoose('Win32', 'Mac', 'Linux');

    // Build json
    const re = {
        configurations: [
            {
                name: platformName,
                defines: envDefines,
                includePath: envIncludes,
                compilerPath: compilerPath,
                cStandard: envCStd,
                cppStandard: compileStdCpp,
                intelliSenseMode: intelliSense,
            },
        ],
        version: 4,
    };
    const ser = JSON.stringify(re, null, 2);

    // Write file
    const vscodeDir = path.join(workspaceFolder, '.vscode');
    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir);
    }
    fs.writeFileSync(path.join(vscodeDir, 'c_cpp_properties.json'), ser);
}

async function collectRLinkingTo(workspaceFolder: string): Promise<string[]> {
    if (!fs.existsSync(path.join(workspaceFolder, 'DESCRIPTION'))) {
        return [];
    }

    const rScript = extensionContext
        .asAbsolutePath('R/cppProperties/extractLinkingTo.R')
        .replace(/\\/g, '/');
    const linkingToIncludesStr = (
        await executeRCommand(
            `source(${ToRStringLiteral(rScript, '"')})`,
            workspaceFolder,
            (e: Error) => {
                void window.showErrorMessage(e.message);
                return '';
            },
        )
    )?.trim();
    if (!linkingToIncludesStr || linkingToIncludesStr === '') {
        return [];
    }
    return linkingToIncludesStr.split(/\r?\n/g).map(decodeURI);
}

function ensureUnquoted(str: string): string {
    if (/(^".*"$)|(^'.*'$)/.test(str)) {
        return str.substring(1, str.length - 1);
    }
    return str;
}

function extractCompilerInfo(compileOutput: string) {
    const rxCompArg = /-(I|D)("[^"]+"|[\S]+)/gm;

    const compDefines: string[] = [];
    const compIncludes: string[] = [];
    const compLookup = { D: compDefines, I: compIncludes };

    let m: RegExpExecArray | null;
    while ((m = rxCompArg.exec(compileOutput)) !== null) {
        if (m.index === rxCompArg.lastIndex) {
            rxCompArg.lastIndex++;
        }

        // The regex guarantees that the first group is 'I' or 'D'
        compLookup[m[1] as 'D' | 'I'].push(ensureUnquoted(m[2]));
    }

    return {
        compDefines: compDefines,
        compIncludes: compIncludes,
    };
}

function extractCompilerStd(compileOutput: string): string | undefined {
    const rxStd = /-std=(\S+)/;

    const stdMatch = compileOutput.match(rxStd);
    return stdMatch?.[1];
}

function extractCompilerCall(compileOutput: string): string | undefined {
    const rxComp = /("[^"]+"|[\S]+)/;
    const ccalls = compileOutput.split('\n');
    if (ccalls.length < 2) {
        return undefined;
    }

    const m = ccalls[1].match(rxComp);
    return m ? ensureUnquoted(m[1]) : undefined;
}

async function collectCompilerOutput(
    rPath: string,
    workspaceFolder: string,
    testExtension: 'cpp' | 'c',
): Promise<string> {
    const makevarsFiles = ['Makevars', 'Makevars.win', 'Makevars.ucrt'];

    const srcFolder = path.join(workspaceFolder, 'src');
    const tempFolder = createTempDir(workspaceFolder);

    try {
        // Copy makevars
        if (fs.existsSync(srcFolder)) {
            const projectMakevarsFiles = fs
                .readdirSync(srcFolder)
                .filter((fn) => makevarsFiles.includes(fn));
            for (const f of projectMakevarsFiles) {
                fs.copyFileSync(path.join(srcFolder, f), path.join(tempFolder, f));
            }
        }

        // Create dummy source file
        const testFile = `comp_test.${testExtension}`;
        fs.writeFileSync(path.join(tempFolder, testFile), '');

        // Compile dummy
        const result = await spawnAsync(rPath, ['CMD', 'SHLIB', testFile], { cwd: tempFolder });
        if (result.status !== 0) {
            throw (
                result.error ??
                new Error(result.stderr || 'Could not determine R compiler settings.')
            );
        }
        return result.stdout;
    } finally {
        fs.rmSync(tempFolder, { recursive: true, force: true });
    }
}
