import * as vscode from 'vscode';

import { AbstractRExecutable, VirtualRExecutable } from './class';

export type RExecutableType = AbstractRExecutable;
export type VirtualRExecutableType = VirtualRExecutable;

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
	executable: RExecutableType | undefined
}
