import { RHelp } from './helpViewer';
import { RExtension, RSessionApi } from './api';
import { getRpath } from './util';
import * as vscode from 'vscode';

export class RExtensionImplementation implements RExtension  {
    public helpPanel?: RHelp;
    public session!: RSessionApi;
    public async getRExecutablePath(quote?: boolean, resource?: vscode.Uri): Promise<string | undefined> {
        return getRpath(quote, resource);
    }
}


