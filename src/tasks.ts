'use strict';

import * as vscode from 'vscode';

interface RTaskDefinition extends vscode.TaskDefinition {
    command: string | vscode.ShellQuotedString;
    args: (string | vscode.ShellQuotedString)[];
}

export class RTaskProvider implements vscode.TaskProvider {
    public readonly type = 'R';

    private getTask(name: string, definition: RTaskDefinition, problemMatchers?: string | string[]): vscode.Task {
        return new vscode.Task(
            definition,
            vscode.TaskScope.Workspace,
            name,
            'R',
            new vscode.ShellExecution(
                definition.command,
                definition.args
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
                {
                    value: 'devtools::build()',
                    quoting: vscode.ShellQuoting.Strong
                }
            ]
        }),
        this.getTask('Check', {
            type: this.type,
            command: 'Rscript',
            args: [
                '-e',
                {
                    value: 'devtools::check()',
                    quoting: vscode.ShellQuoting.Strong
                }
            ]
        }),
        this.getTask('Document', {
            type: this.type,
            command: 'Rscript',
            args: [
                '-e',
                {
                    value: 'devtools::document()',
                    quoting: vscode.ShellQuoting.Strong
                }
            ]
        }),
        this.getTask('Install', {
            type: this.type,
            command: 'Rscript',
            args: [
                '-e',
                {
                    value: 'devtools::install()',
                    quoting: vscode.ShellQuoting.Strong
                }
            ]
        }),
        this.getTask('Test', {
            type: this.type,
            command: 'Rscript',
            args: [
                '-e',
                {
                    value: 'devtools::test()',
                    quoting: vscode.ShellQuoting.Strong
                }
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
