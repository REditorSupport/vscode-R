


export declare class RExtension {
    helpPanel: HelpPanel;
}


export interface HelpPanel {
	dispose(): void;
	showHelpForInput(): Promise<boolean>;
	showHelpForFunctionName(fncName: string, pkgName: string): void;
	showHelpForPath(requestPath: string): void;
}



