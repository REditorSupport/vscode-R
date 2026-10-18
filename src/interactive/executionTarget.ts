import type { Uri } from 'vscode';
import type { SourceLocation } from './protocol';

export type ExecutionResult = 'executed' | 'cancelled' | 'createTerminal' | false;
let executor:
    | ((
          code: string,
          resource?: Uri,
          source?: SourceLocation,
          offerTarget?: boolean,
      ) => Promise<ExecutionResult>)
    | undefined;

export function setInteractiveExecutor(value: typeof executor): void {
    executor = value;
}

export async function tryInteractiveExecution(
    code: string,
    resource?: Uri,
    source?: SourceLocation,
    offerTarget = false,
): Promise<ExecutionResult> {
    return executor ? executor(code, resource, source, offerTarget) : false;
}
