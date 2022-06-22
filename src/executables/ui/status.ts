import * as vscode from 'vscode';

import { VirtualRExecutable } from '../executable';
import { RExecutableService } from '../service';

enum BinText {
    name = 'R Language Indicator',
    missing = '$(warning) Select executable'
}

export class ExecutableStatusItem implements vscode.Disposable  {
    private service: RExecutableService;
    private languageStatusItem: vscode.LanguageStatusItem;

    private createItem(): vscode.LanguageStatusItem {
        this.languageStatusItem = vscode.languages.createLanguageStatusItem('R Executable Selector', ['r', 'rmd']);
        this.languageStatusItem.name = 'R Language Service';
        this.languageStatusItem.command = {
            'title': 'Select R executable',
            'command': 'r.setExecutable'
        };
        this.refresh();
        return this.languageStatusItem;
    }

    public constructor(service: RExecutableService) {
        this.service = service;
        this.createItem();
     }

    public refresh(): void {
        const execState = this.service.activeExecutable;
        if (execState) {
            this.languageStatusItem.severity = vscode.LanguageStatusSeverity.Information;
            this.languageStatusItem.detail = execState.rBin;
            if (execState instanceof VirtualRExecutable) {
                this.languageStatusItem.text = `${execState.name} (${execState.rVersion})`;
            } else {
                this.languageStatusItem.text = execState.rVersion;
            }
        } else {
            this.languageStatusItem.severity = vscode.LanguageStatusSeverity.Warning;
            this.languageStatusItem.text = BinText.missing;
            this.languageStatusItem.detail = '';
        }
    }

    public async busy(prom: Promise<unknown>): Promise<void> {
        this.languageStatusItem.busy = true;
        await prom;
        this.languageStatusItem.busy = false;
    }

    public dispose(): void {
        this.languageStatusItem.dispose();
    }

}
