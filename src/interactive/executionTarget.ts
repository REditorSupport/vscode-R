import type { Uri } from 'vscode';
import type { SourceLocation } from './protocol';

let executor: ((code: string, resource?: Uri, source?: SourceLocation) => Promise<boolean>) | undefined;

export function setInteractiveExecutor(value: typeof executor): void { executor = value; }

export async function tryInteractiveExecution(code: string, resource?: Uri, source?: SourceLocation): Promise<boolean> {
    return executor ? executor(code, resource, source) : false;
}
