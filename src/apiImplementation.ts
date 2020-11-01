

import { HelpPanel } from './rHelpPanel';

import { RExtension } from './api';


export class RExtensionImplementation implements RExtension  {
    constructor(){}

    public helpPanel: HelpPanel;

    public sayHello(): string {
        return 'Hello World from vscode-R!';
    }
}



