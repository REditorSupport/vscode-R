'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RExecutableType, isVirtual, setupVirtualAwareProcessArguments } from './executables';
import { rExecutableManager } from './extension';


const TYPE = 'R';

interface RTaskDefinition extends vscode.TaskDefinition {
    type: string,
    code: string[],
    options?: string[],
    cwd?: string,
    env?: { [key: string]: string }
}

interface RTaskInfo {
    definition: RTaskDefinition,
    problemMatchers?: string | string[],
    name?: string,
    group?: vscode.TaskGroup
}

function makeRArgs(options: string[], code: string[]) {
    const codeArgs: string[] = [];
    for (const line of code) {
        codeArgs.push('-e');
        codeArgs.push(line);
    }
    const args = options.concat(codeArgs);
    return args;
}

const defaultOptions: string[] = ['--no-echo', '--no-restore'];
const rtasks: RTaskInfo[] = [
    {
        definition: {
            type: TYPE,
            code: ['devtools::test()']
        },
        name: 'Test',
        group: vscode.TaskGroup.Test,
        problemMatchers: '$testthat'
    },

    {
        definition: {
            type: TYPE,
            code: ['testthat::test_file("${file}")']
        },
        name: 'Test (Current File)',
        group: vscode.TaskGroup.Test,
        problemMatchers: '$testthat'
    },

    {
        definition: {
            type: TYPE,
            code: ['devtools::build()']
        },
        name: 'Build',
        group: vscode.TaskGroup.Build,
        problemMatchers: []
    },

    {
        definition: {
            type: TYPE,
            code: ['devtools::build(binary = TRUE, args = c(\'--preclean\'))']
        },
        name: 'Build Binary',
        group: vscode.TaskGroup.Build,
        problemMatchers: []
    },

    {
        definition: {
            type: TYPE,
            code: ['devtools::check()']
        },
        name: 'Check',
        group: vscode.TaskGroup.Test,
        problemMatchers: []
    },

    {
        definition: {
            type: TYPE,
            code: ['devtools::document()']
        },
        name: 'Document',
        group: vscode.TaskGroup.Build,
        problemMatchers: []
    },

    {
        definition: {
            type: TYPE,
            code: ['devtools::install()']
        },
        name: 'Install',
        group: vscode.TaskGroup.Build,
        problemMatchers: []
    }
];

function asRTask(executable: RExecutableType, folder: vscode.WorkspaceFolder | vscode.TaskScope, info: RTaskInfo): vscode.Task {
    const args = makeRArgs(info.definition.options ?? defaultOptions, info.definition.code);
    const processArgs = setupVirtualAwareProcessArguments(executable, false, args);

    const rtask: vscode.Task = new vscode.Task(
        info.definition,
        folder,
        info.name ?? 'Unnamed',
        info.definition.type,
        new vscode.ProcessExecution(
            processArgs.cmd,
            processArgs.args ?? [],
            {
                cwd: info.definition.cwd,
                env: info.definition.env
            }
        ),
        info.problemMatchers
    );

    rtask.group = info.group;
    return rtask;
}

export class RTaskProvider implements vscode.TaskProvider {

    public type = TYPE;

    public provideTasks(): vscode.Task[] {
        const folders = vscode.workspace.workspaceFolders;

        if (!folders) {
            return [];
        }

        const tasks: vscode.Task[] = [];
        const rexecutable = rExecutableManager?.activeExecutable;
        if (!rexecutable) {
            return [];
        }

        for (const folder of folders) {
            const isRPackage = fs.existsSync(path.join(folder.uri.fsPath, 'DESCRIPTION'));
            if (isRPackage) {
                for (const rtask of rtasks) {
                    const task = asRTask(rexecutable, folder, rtask);
                    tasks.push(task);
                }
            }
        }
        return tasks;
    }

    public resolveTask(task: vscode.Task): vscode.Task {
        const taskInfo: RTaskInfo = {
            definition: <RTaskDefinition>task.definition,
            group: task.group,
            name: task.name
        };
        const rexecutable = rExecutableManager?.activeExecutable;
        if (!rexecutable) {
            void vscode.window.showErrorMessage('Cannot run task. No valid R executable path set.');
            throw 'R path not set.';
        }
        return asRTask(rexecutable, vscode.TaskScope.Workspace, taskInfo);
    }
}
