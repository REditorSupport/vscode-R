'use strict';

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { window } from 'vscode';
import { getRpath, getCurrentWorkspaceFolder, executeRCommand } from './util';
import { execSync } from 'child_process';

export async function generateCppProperties(): Promise<void> {
    const currentWorkspaceFolder = getCurrentWorkspaceFolder()?.uri.fsPath;
    if (currentWorkspaceFolder === undefined) {
        void window.showWarningMessage('Please open a workspace folder to create c_cpp_properties.json');
        return;
    }
    const outFilePath = path.join(currentWorkspaceFolder, '.vscode', 'c_cpp_properties.json');
    if (fs.existsSync(outFilePath)) {
        const overwrite = await window.showWarningMessage(
            '"c_cpp_properties.json" file already exists. Do you want to overwrite?',
            'Yes', 'No'
        );
        if (overwrite === 'No') {
            return;
        }
        void fs.unlinkSync(outFilePath);
    }
    return generateCppPropertiesProc(currentWorkspaceFolder);
}

/** Helper: Return object depending on current process platform */
function platformChoose<A, B, C>(win32: A, darwin: B, other: C): A | B | C {
    return process.platform === 'win32' ? win32 :
        process.platform === 'darwin' ? darwin :
            other;
}

// See: https://code.visualstudio.com/docs/cpp/c-cpp-properties-schema-reference
async function generateCppPropertiesProc(workspaceFolder: string) {
    const rPath = await getRpath();

    // Collect information from running the compiler
    const configureFile = platformChoose('configure.win', 'configure', 'configure');
    const cleanupFile = platformChoose('cleanup.win', 'cleanup', 'cleanup');

    if (fs.existsSync(path.join(workspaceFolder, configureFile))) {
        await executeRCommand(`system("sh ./${configureFile}")`, workspaceFolder, (e: Error) => {
            void window.showErrorMessage(e.message);
            return '';
        });
    }

    const compileOutputCpp = collectCopilerOutput(rPath, workspaceFolder, 'cpp');
    const compileOutputC = collectCopilerOutput(rPath, workspaceFolder, 'c');

    if (fs.existsSync(path.join(workspaceFolder, cleanupFile))) {
        await executeRCommand(`system("sh ./${cleanupFile}")`, workspaceFolder, (e: Error) => {
            void window.showErrorMessage(e.message);
            return '';
        });
    }

    const compileInfo = extractCompilerInfo(compileOutputCpp);
    const compileStdCpp = extractCompilerStd(compileOutputCpp);
    const compileStdC = extractCompilerStd(compileOutputC);
    const compileCall = extractCompilerCall(compileOutputCpp);
    const compilerPath = await executeRCommand(`cat(Sys.which("${compileCall}"))`, workspaceFolder, (e: Error) => {
        void window.showErrorMessage(e.message);
        return '';
    });

    const intelliSensePlatform = platformChoose('windows', 'macos', 'linux');
    const intelliSenseComp = compileCall.includes('clang') ? 'clang' : 'gcc';
    const intelliSense = `${intelliSensePlatform}-${intelliSenseComp}-${process.arch}`;

    // Collect information from 'DESCRIPTION'
    const linkingToIncludes = await collectRLinkingTo(workspaceFolder);

    // Combine information
    const envIncludes: string[] = ['${workspaceFolder}/src'];
    envIncludes.push(...compileInfo.compIncludes.map((v) => path.isAbsolute(v) ? v : `\${workspaceFolder}/${path.join('src', v)}`));
    envIncludes.push(...linkingToIncludes);

    const envDefines = compileInfo.compDefines;

    const platformName = platformChoose('Win32', 'Mac', 'Linux');

    // Build json
    const re = {
        'configurations': [{
            'name': platformName,
            'defines': envDefines,
            'includePath': envIncludes,
            'compilerPath': compilerPath,
            'cStandard': compileStdC,
            'cppStandard': compileStdCpp,
            'intelliSenseMode': intelliSense
        }],
        'version': 4
    };
    const ser = JSON.stringify(re, null, 2);

    // Write file
    const vscodeDir = path.join(workspaceFolder, '.vscode');
    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir);
    }
    fs.writeFileSync(path.join(vscodeDir, 'c_cpp_properties.json'), ser);
}

function encodeRCommand(command: string) {
    command = command.replaceAll('\\', '\\\\');
    command = command.replaceAll(' ', '');
    command = command.replaceAll('"', '\'');
    return command;
}

async function collectRLinkingTo(workspaceFolder: string): Promise<string[]> {
    if (!fs.existsSync(path.join(workspaceFolder, 'DESCRIPTION'))) {
        return [];
    }

    // R 'DESCRIPTION' file is in DCF (Debian config file) format
    const rCodeExtractDeps = `cat(paste(vapply(strsplit(gsub("\\s|\\n|(\\([^\\)]*\\))", "", unname(read.dcf("DESCRIPTION","LinkingTo")[1,])),",")[[1]], function(pkg) { system.file("include",package=pkg) }, character(1)), collapse = "////"))`;

    const linkingToIncludesStr = await executeRCommand(encodeRCommand(rCodeExtractDeps), workspaceFolder, (e: Error) => {
        void window.showErrorMessage(e.message);
        return '';
    });
    return linkingToIncludesStr.split('////');
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
    const compLookup = { 'D': compDefines, 'I': compIncludes };

    let m: RegExpExecArray;
    while ((m = rxCompArg.exec(compileOutput)) !== null) {
        if (m.index === rxCompArg.lastIndex) {
            rxCompArg.lastIndex++;
        }

        // The regex guarantees that the first group is 'I' or 'D'
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        compLookup[m[1]].push(ensureUnquoted(m[2]));
    }

    return {
        compDefines: compDefines,
        compIncludes: compIncludes
    };
}

function extractCompilerStd(compileOutput: string): string | null {
    const rxStd = /-std=(\S+)/;

    const stdMatch = compileOutput.match(rxStd);
    return stdMatch?.[1];
}

function extractCompilerCall(compileOutput: string): string | null {
    const rxComp = /("[^"]+"|[\S]+)/;
    const ccalls = compileOutput.split('\n');
    if (ccalls.length < 2) {
        return null;
    }

    const m = ccalls[1].match(rxComp);
    return m?.[1];
}

function createTempDir(root: string): string {
    let tempDir: string;
    while (fs.existsSync(tempDir = path.join(root, `___temp_${randomBytes(8).toString('hex')}`))) { /* Name clash */ }
    fs.mkdirSync(tempDir);
    return tempDir;
}

function collectCopilerOutput(rPath: string, workspaceFolder: string, testExtension: 'cpp' | 'c') {

    const makevarsFiles = ['Makevars', 'Makevars.win', 'Makevars.ucrt'];

    const srcFolder = path.join(workspaceFolder, 'src');
    const tempFolder = createTempDir(workspaceFolder);

    // Copy makevars
    if (fs.existsSync(srcFolder)) {
        const projectMakevarsFiles = fs.readdirSync(srcFolder).filter(fn => makevarsFiles.includes(fn));
        for (const f of projectMakevarsFiles) {
            fs.copyFileSync(path.join(srcFolder, f), path.join(tempFolder, f));
        }
    }

    // Create dummy source file
    const testFile = `comp_test.${testExtension}`;
    fs.writeFileSync(path.join(tempFolder, testFile), '');

    // Compile dummy
    const command = `"${rPath}" CMD SHLIB ${testFile}`;
    const compileOutput = execSync(command, {
        cwd: tempFolder
    }).toString();

    // Cleanup
    fs.rmSync(tempFolder, { recursive: true, force: true });

    return compileOutput;
}