import * as vscode from 'vscode';

import { AbstractExecutable, VirtualRExecutable } from './class';

export type ExecutableType = AbstractExecutable;
export type VirtualExecutableType = VirtualRExecutable;

export interface IExecutableDetails {
	version: string | undefined,
	arch: string | undefined
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
