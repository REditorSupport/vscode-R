'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getRpath } from './util';
import { extensionContext } from './extension';


export const R_TASK_TYPE = 'R';


interface RTaskDefinition extends vscode.TaskDefinition {
    type: typeof R_TASK_TYPE,
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
            type: R_TASK_TYPE,
            code: ['devtools::test()']
        },
        name: 'Test',
        group: vscode.TaskGroup.Test,
        problemMatchers: '$testthat'
    },

    {
        definition: {
            type: R_TASK_TYPE,
            code: ['devtools::build()']
        },
        name: 'Build',
        group: vscode.TaskGroup.Build,
        problemMatchers: []
    },

    {
        definition: {
            type: R_TASK_TYPE,
            code: ['devtools::build(binary = TRUE, args = c(\'--preclean\'))']
        },
        name: 'Build Binary',
        group: vscode.TaskGroup.Build,
        problemMatchers: []
    },

    {
        definition: {
            type: R_TASK_TYPE,
            code: ['devtools::check()']
        },
        name: 'Check',
        group: vscode.TaskGroup.Test,
        problemMatchers: []
    },

    {
        definition: {
            type: R_TASK_TYPE,
            code: ['devtools::document()']
        },
        name: 'Document',
        group: vscode.TaskGroup.Build,
        problemMatchers: []
    },

    {
        definition: {
            type: R_TASK_TYPE,
            code: ['devtools::install()']
        },
        name: 'Install',
        group: vscode.TaskGroup.Build,
        problemMatchers: []
    }
];

function asRTask0(rPath: string, folder: vscode.WorkspaceFolder | vscode.TaskScope, info: RTaskInfo): vscode.Task {
    const args = makeRArgs(info.definition.options ?? defaultOptions, info.definition.code);
    const rtask: vscode.Task = new vscode.Task(
        info.definition,
        folder,
        info.name ?? 'Unnamed',
        info.definition.type,
        new vscode.ProcessExecution(
            rPath,
            args,
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

function asRTask(rPath: string, folder: vscode.WorkspaceFolder | vscode.TaskScope, info: RTaskInfo): vscode.Task {
    // const args = makeRArgs(info.definition.options ?? defaultOptions, info.definition.code);
    const args = [
        '--silent',
        '--no-save',
        '--no-restore',
    ];
    const rProfile = extensionContext.asAbsolutePath('R/interactiveTask.Rprofile');
    const rtask: vscode.Task = new vscode.Task(
        info.definition,
        folder,
        info.name ?? 'Unnamed',
        info.definition.type,
        new vscode.ProcessExecution(
            rPath,
            args,
            {
                cwd: info.definition.cwd,
                env: {
                    ...info.definition.env,
                    R_PROFILE_USER: rProfile,
                    VSCODE_EVAL_CODE: info.definition.code.join('; ')
                }
            }
        ),
        info.problemMatchers
    );

    rtask.group = info.group;
    return rtask;
}

export class RTaskProvider implements vscode.TaskProvider {

    public async provideTasks(): Promise<vscode.Task[]> {
        const folders = vscode.workspace.workspaceFolders;

        if (!folders) {
            return [];
        }

        const tasks: vscode.Task[] = [];
        const rPath = await getRpath(false);
        if (!rPath) {
            return [];
        }

        for (const folder of folders) {
            const isRPackage = fs.existsSync(path.join(folder.uri.fsPath, 'DESCRIPTION'));
            if (isRPackage) {
                for (const rtask of rtasks) {
                    const task = asRTask(rPath, folder, rtask);
                    tasks.push(task);
                }
            }
        }
        return tasks;
    }

    public async resolveTask(task: vscode.Task): Promise<vscode.Task> {
        const taskInfo: RTaskInfo = {
            definition: <RTaskDefinition>task.definition,
            group: task.group,
            name: task.name
        };
        const rPath = await getRpath(false);
        if (!rPath) {
            throw 'R path not set.';
        }
        return asRTask(rPath, vscode.TaskScope.Workspace, taskInfo);
    }
}
