'use strict';

import * as vscode from 'vscode';

const type = 'R';

// `vscode.ShellQuoting.Strong` will treat the "value" as pure string
// and quote them based on the shell used this can ensure it works for
// different shells, e.g., zsh, PowerShell or cmd

export const rtasks = [

    new vscode.Task(
        { type: type },
        vscode.TaskScope.Workspace,
        'Build',
        'R',
        new vscode.ShellExecution(
            'Rscript',
            [
                '-e',
                {
                    value: 'devtools::build()',
                    quoting: vscode.ShellQuoting.Strong
                }
            ]
        )
    ),
    
    new vscode.Task(
        { type: type },
        vscode.TaskScope.Workspace,
        'ttest',
        'R',
        new vscode.ShellExecution(
            'echo',
            [
                'hello',
                'world'
            ]
        )
    ),
    
    new vscode.Task(
        { type: type },
        vscode.TaskScope.Workspace,
        'Check',
        'R',
        new vscode.ShellExecution(
            'Rscript',
            [
                '-e',
                {
                    value: 'devtools::check()',
                    quoting: vscode.ShellQuoting.Strong
                }
            ]
        )
    ),
    
    new vscode.Task(
        { type: type },
        vscode.TaskScope.Workspace,
        'Document',
        'R',
        new vscode.ShellExecution(
            'Rscript',
            [
                '-e',
                {
                    value: 'devtools::document()',
                    quoting: vscode.ShellQuoting.Strong
                }
            ]
        )
    ),
    
    new vscode.Task(
        { type: type },
        vscode.TaskScope.Workspace,
        'Install',
        'R',
        new vscode.ShellExecution(
            'Rscript',
            [
                '-e',
                {
                    value: 'devtools::install()',
                    quoting: vscode.ShellQuoting.Strong
                }
            ]
        )
    ),
    
    new vscode.Task(
        { type: type },
        vscode.TaskScope.Workspace,
        'Test',
        'R',
        new vscode.ShellExecution(
            'Rscript',
            [
                '-e',
                {
                    value: 'devtools::test()',
                    quoting: vscode.ShellQuoting.Strong
                }
            ]
        ),
        '$testthat'
    )
];
