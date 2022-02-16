'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { makeTerminalOptions } from './rTerminal';


const TYPE = 'R';

interface RTaskDefinition extends vscode.TaskDefinition {
    type: string,
    code: string[],
    args?: string[],
    cwd?: string,
    env?: { [key: string]: string }
}

interface RTaskMeta {
    definition: RTaskDefinition,
    problemMatchers?: string | string[],
    name?: string,
    group?: vscode.TaskGroup
}


const getRterm = async function ():Promise<string> {
    const termOptions = await makeTerminalOptions();
    const termPath = termOptions.shellPath;
    return termPath ?? 'R';
};


const zipRTermArguments = function (code: string[], args: string[]) {
    const codeLines: string[] = [];
    for (const line of code) {
        codeLines.push(...['-e', line]);
    }
    const RtermArgs = args.concat(codeLines);
    return RtermArgs;
};


const RTasksMeta: RTaskMeta[] = [
    {
        definition: {
            type: TYPE,
            code: ['devtools::test()'],
            args: ['--no-echo', '--no-restore']
        },
        name: 'Test',
        group: vscode.TaskGroup.Test,
        problemMatchers: '$testthat'
    },
    
    {
        definition: {
            type: TYPE,
            code: ['devtools::build()'],
            args: ['--no-echo', '--no-restore']
        },
        name: 'Build',
        group: vscode.TaskGroup.Build,
        problemMatchers: []
    },
    
    {
        definition: {
            type: TYPE,
            code: ['devtools::check()'],
            args: ['--no-echo', '--no-restore']
        },
        name: 'Check',
        group: vscode.TaskGroup.Test,
        problemMatchers: []
    },

    {
        definition: {
            type: TYPE,
            code: ['devtools::document()'],
            args: ['--no-echo', '--no-restore']
        },
        name: 'Document',
        group: vscode.TaskGroup.Build,
        problemMatchers: []
    },
    
    {
        definition: {
            type: TYPE,
            code: ['devtools::install()'],
            args: ['--no-echo', '--no-restore']
        },
        name: 'Install',
        group: vscode.TaskGroup.Build,
        problemMatchers: []
    }
];




const asRTask = async function (
    folder: vscode.WorkspaceFolder | vscode.TaskScope,
    meta: RTaskMeta
): Promise<vscode.Task> {

    const Rterm = await getRterm();
    const RtermArgs = zipRTermArguments(meta.definition.code, meta.definition.args ?? []);

    const rtask: vscode.Task = new vscode.Task(
        meta.definition,
        folder,
        meta.name,
        meta.definition.type,
        new vscode.ProcessExecution(
            Rterm,
            RtermArgs,
            {
                cwd: meta.definition.cwd,
                env: meta.definition.env
            }
        ),
        meta.problemMatchers
    );
    
    rtask.group = meta.group;
    return rtask;
};



export class RTaskProvider implements vscode.TaskProvider {
    
    public type = TYPE;

    public async provideTasks(): Promise<vscode.Task[]> {        
        const folders = vscode.workspace.workspaceFolders;
        
        if (!folders) {
            return [] as vscode.Task[];
        }
        
        const tasks: vscode.Task[] = [];
        
        for (const folder of folders) {
            const isRPackage = fs.existsSync(path.join(folder.uri.fsPath, 'DESCRIPTION'));
            if (isRPackage) {
                for (const rtask of RTasksMeta) {
                    const task = await asRTask(folder, rtask);
                    tasks.push(task);
                }
            }
        }
        return tasks;
    }

    public async resolveTask(task: vscode.Task): Promise<vscode.Task> {
        const taskMeta: RTaskMeta = {
            definition: <RTaskDefinition>task.definition,
            group: task.group,
            name: task.name
        };
        return await asRTask(vscode.TaskScope.Workspace, taskMeta);
    }
}
