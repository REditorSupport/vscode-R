
// declaration of the api exported by the extension
// implemented in apiImplementation.ts 
// used e.g. by vscode-r-debugger to show the help panel from within debug sessions


export declare class RExtension {
    helpPanel?: HelpPanel;
}


export interface HelpPanel {
	dispose(): void;
	showHelpForInput(): Promise<boolean>;
	showHelpForFunctionName(fncName: string, pkgName: string): void;
	showHelpForPath(requestPath: string): void;
}



