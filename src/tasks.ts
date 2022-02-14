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

    private getTask(name: string, definition: RTaskDefinition, problemMatchers?: string | string[]): vscode.Task {
        return new vscode.Task(
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
    }

    // `vscode.ShellQuoting.Strong` will treat the "value" as pure string
    // and quote them based on the shell used this can ensure it works for
    // different shells, e.g., zsh, PowerShell or cmd
    private readonly tasks = [
        this.getTask('Build', {
            type: this.type,
            command: 'Rscript',
            args: [
                '-e',
                'devtools::build()'
            ]
        }),
        this.getTask('Check', {
            type: this.type,
            command: 'Rscript',
            args: [
                '-e',
                'devtools::check()'
            ]
        }),
        this.getTask('Document', {
            type: this.type,
            command: 'Rscript',
            args: [
                '-e',
                'devtools::document()'
            ]
        }),
        this.getTask('Install', {
            type: this.type,
            command: 'Rscript',
            args: [
                '-e',
                'devtools::install()'
            ]
        }),
        this.getTask('Test', {
            type: this.type,
            command: 'Rscript',
            args: [
                '-e',
                'devtools::test()'
            ]
        }, '$testthat'),
    ];

    public provideTasks(): vscode.Task[] {
        return this.tasks;
    }

    public resolveTask(task: vscode.Task): vscode.Task {
        return this.getTask(
            task.name,
            <RTaskDefinition>task.definition,
            task.problemMatchers
        );
    }
}
