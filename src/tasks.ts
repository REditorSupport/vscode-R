'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface RTaskDefinition extends vscode.TaskDefinition {
    code: string[];
    cwd?: string;
    env?: { [key: string]: string };
}


const TYPE = 'R';

class TaskMeta {
    constructor(
        public name: string,
        public definition: RTaskDefinition,
        public group?: vscode.TaskGroup,
        public problemMatchers?: string | string[],
    ) {}
}


const rtasks: TaskMeta[] = [
    new TaskMeta(
        'Test',
        {
            type: TYPE,
            code: ['devtools::test()']
        },
        vscode.TaskGroup.Test,
        '$testthat'
    ),
    
    new TaskMeta(
        'Build',
        {
            type: TYPE,
            code: [ 'devtools::build()' ]
        },
        vscode.TaskGroup.Build
    ),

    new TaskMeta(
        'Check',
        {
            type: TYPE,
            code: [ 'devtools::check()' ]
        },
        vscode.TaskGroup.Test
    ),
    
    new TaskMeta(
        'Document',
        {
            type: TYPE,
            code: [ 'devtools::document()' ]
        },
        vscode.TaskGroup.Build
    ),
    
    new TaskMeta(
        'Install',
        {
            type: TYPE,
            code: [ 'devtools::install()' ]
        },
        vscode.TaskGroup.Build
    )
];


const asTask = function (
    folder: vscode.WorkspaceFolder | vscode.TaskScope,
    meta: TaskMeta
): vscode.Task {
    const codeLines: string[] = [];
    for (const line of meta.definition.code) {
        codeLines.push('-e');
        codeLines.push(line);
    }
    const task: vscode.Task = new vscode.Task(
        meta.definition,
        folder,
        meta.name,
        TYPE,
        new vscode.ProcessExecution(
            'Rscript',
            codeLines,
            {
                cwd: meta.definition.cwd,
                env: meta.definition.env
            }
        ),
        meta.problemMatchers
    );
    
    if (meta.group) {
        task.group = meta.group;
    }
    
    return task;
};



export class RTaskProvider implements vscode.TaskProvider {
    
    public type = TYPE;

    public provideTasks(): vscode.Task[] {        
        const folders = vscode.workspace.workspaceFolders;
        
        if (!folders) {
            return [] as vscode.Task[];
        }
        
        const tasks: vscode.Task[] = [];
        
        for (const folder of folders) {
            const isRPackage = fs.existsSync(path.join(folder.uri.fsPath, 'DESCRIPTION'));
            if (isRPackage) {
                for (const rtask of rtasks) {
                    const task = asTask(folder, rtask);
                    tasks.push(task);
                }
            }
        }
        return tasks;
    }

    public resolveTask(task: vscode.Task): vscode.Task {
        return asTask(
            vscode.TaskScope.Workspace,
            new TaskMeta(
                task.name,
                <RTaskDefinition>task.definition,
                task.group,
                task.problemMatchers
            )
        );
    }
}
