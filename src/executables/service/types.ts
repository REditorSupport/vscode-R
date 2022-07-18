import * as vscode from 'vscode';

import { AbstractExecutable, VirtualRExecutable } from './class';

export type ExecutableType = AbstractExecutable;
export type VirtualExecutableType = VirtualRExecutable;

export interface IExecutableDetails {
	version: string | undefined,
	arch: string | undefined
}

export interface IRenvLock {
	'R': {
		'Version': string,
		'Repositories': Record<string, string>[]
	};
}

/**
 * @description
 * @export
 * @interface WorkspaceExecutableEvent
 */
export interface WorkspaceExecutableEvent {
	workingFolder: vscode.WorkspaceFolder | undefined,
	executable: ExecutableType | undefined
}
