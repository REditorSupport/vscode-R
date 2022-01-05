
// declaration of the api exported by the extension
// implemented in apiImplementation.ts 
// used e.g. by vscode-r-debugger to show the help panel from within debug sessions


export declare class RExtension {
    helpPanel?: HelpPanel;
}

export type HelpSubMenu = 'doc' | 'pkgList' | 'refresh' | '?' | '??';

export interface HelpPanel {
	showHelpForPath(requestPath?: string): void;
	dispose(): void;
	refresh(): void;
}



