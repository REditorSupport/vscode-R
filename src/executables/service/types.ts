'use strict';

import * as vscode from 'vscode';
import { AbstractRExecutable, AbstractVirtualRExecutable } from './class';

export type RExecutableType = AbstractRExecutable;
export type VirtualRExecutableType = AbstractVirtualRExecutable;

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