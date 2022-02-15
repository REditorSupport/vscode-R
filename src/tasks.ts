'use strict';

import * as vscode from 'vscode';

interface RTaskDefinition extends vscode.TaskDefinition {
    command: string;
    args: string[];
    cwd?: string;
    env?: { [key: string]: string };
}

export class RTaskProvider implements vscode.TaskProvider {
    public readonly type = 'R';

    private getTask(name: string, definition: RTaskDefinition, group?: vscode.TaskGroup, problemMatchers?: string | string[]): vscode.Task {
        const task: vscode.Task = new vscode.Task(
            definition,
            vscode.TaskScope.Workspace,
            name,
            'R',
            new vscode.ProcessExecution(
                definition.command,
                definition.args,
                {
                    cwd: definition.cwd,
                    env: definition.env
                }
            ),
            problemMatchers
        );
        
        if (group) {
            task.group = group;
        }
        
        return task;
    }

    private readonly tasks = [
        this.getTask(
            'Build',
            {
                type: this.type,
                command: 'Rscript',
                args: [
                    '-e',
                    'devtools::build()'
                ]
            },
            vscode.TaskGroup.Build
        ),

        this.getTask(
            'Check',
            {
                type: this.type,
                command: 'Rscript',
                args: [
                    '-e',
                    'devtools::check()'
                ]
            },
            vscode.TaskGroup.Test,
        ),

        this.getTask(
            'Document',
            {
                type: this.type,
                command: 'Rscript',
                args: [
                    '-e',
                    'devtools::document()'
                ]
            }
        ),

        this.getTask(
            'Install',
            {
                type: this.type,
                command: 'Rscript',
                args: [
                    '-e',
                    'devtools::install()'
                ]
            },
            vscode.TaskGroup.Build
        ),

        this.getTask(
            'Test',
            {
                type: this.type,
                command: 'Rscript',
                args: [
                    '-e',
                    'devtools::test()'
                ]
            },
            vscode.TaskGroup.Test, 
            '$testthat'
        ),
    ];

    public provideTasks(): vscode.Task[] {
        return this.tasks;
    }

    public resolveTask(task: vscode.Task): vscode.Task {
        return this.getTask(
            task.name,
            <RTaskDefinition>task.definition,
            task.group,
            task.problemMatchers
        );
    }
}
