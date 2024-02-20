import * as util from '../util';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import path = require('path');
import { DisposableProcess, spawn } from '../util';

export enum KnitWorkingDirectory {
    documentDirectory = 'document directory',
    workspaceRoot = 'workspace root',
}

export interface IKnitRejection {
    cp: DisposableProcess;
    wasCancelled: boolean;
}

const rMarkdownOutput: vscode.OutputChannel = vscode.window.createOutputChannel('R Markdown');

interface IKnitArgs {
    workingDirectory: string;
    filePath: string;
    fileName: string;
    scriptArgs: Record<string, string>;
    scriptPath: string;
    rCmd?: string;
    rOutputFormat?: string;
    callback: (dat: string, childProcess?: util.DisposableProcess) => boolean;
    onRejection?: (filePath: string, rejection: IKnitRejection) => unknown;
}

export abstract class RMarkdownManager {
    protected rPath: string | undefined = undefined;
    protected rMarkdownOutput: vscode.OutputChannel = rMarkdownOutput;
    // uri that are in the process of knitting
    // so that we can't spam the knit/preview button
    protected busyUriStore: Set<string> = new Set<string>();

    protected getKnitDir(knitDir: string | undefined, docPath: string): string | undefined {
        switch (knitDir) {
            // the directory containing the R Markdown document
            case KnitWorkingDirectory.documentDirectory: {
                return path.dirname(docPath)?.replace(/\\/g, '/')?.replace(/['"]/g, '\\"') ?? undefined;
            }
            // the root of the current workspace
            case KnitWorkingDirectory.workspaceRoot: {
                const currentDocumentWorkspace = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(docPath) ?? vscode.window.activeTextEditor?.document?.uri)?.uri?.fsPath ?? undefined;
                return currentDocumentWorkspace?.replace(/\\/g, '/')?.replace(/['"]/g, '\\"') ?? undefined;
            }
            // the working directory of the attached terminal, NYI
            // case 'current directory': {
            //     return NULL
            // }
            default: return undefined;
        }
    }

    protected async knitDocument(args: IKnitArgs, token?: vscode.CancellationToken, progress?: vscode.Progress<unknown>): Promise<DisposableProcess | IKnitRejection> {
        // vscode.Progress auto-increments progress, so we use this
        // variable to set progress to a specific number
        let currentProgress = 0;
        let printOutput = true;

        return await new Promise<DisposableProcess>(
            (resolve, reject) => {
                const scriptArgs = args.scriptArgs;
                const scriptPath = args.scriptPath;
                const fileName = args.fileName;
                // const cmd = `${this.rPath} --silent --slave --no-save --no-restore -f "${scriptPath}"`;
                const cpArgs = [
                    '--silent',
                    '--slave',
                    '--no-save',
                    '--no-restore',
                    '-f',
                    scriptPath
                ];
                // When there's no LANG variable, we should try to set to a UTF-8 compatible one, as R relies
                // on locale setting (based on LANG) to render certain characters.
                // See https://github.com/REditorSupport/vscode-R/issues/933
                const env = process.env;
                if (env.LANG === undefined) {
                    env.LANG = 'en_US.UTF-8';
                }
                const processOptions: cp.SpawnOptions = {
                    env: {
                        ...env,
                        ...scriptArgs
                    },
                    cwd: args.workingDirectory,
                };

                let childProcess: DisposableProcess | undefined = undefined;
                try {
                    if (!this.rPath) {
                        throw new Error('R path not defined');
                    }

                    childProcess = spawn(this.rPath, cpArgs, processOptions, () => {
                        rMarkdownOutput.appendLine('[VSC-R] terminating R process');
                        printOutput = false;
                    });
                    progress?.report({
                        increment: 0,
                        message: '0%'
                    });
                } catch (e: unknown) {
                    console.warn(`[VSC-R] error: ${e as string}`);
                    reject({ cp: childProcess, wasCancelled: false });
                    return;
                }

                this.rMarkdownOutput.appendLine(`[VSC-R] ${fileName} process started`);

                if (args.rCmd) {
                    this.rMarkdownOutput.appendLine(`==> ${args.rCmd}`);
                }

                childProcess.stdout.on('data',
                    (data: Buffer) => {
                        const dat = data.toString('utf8');
                        if (printOutput) {
                            this.rMarkdownOutput.appendLine(dat);

                        }
                        const percentRegex = /[0-9]+(?=%)/g;
                        const divisionRegex = /([0-9]+)\/([0-9]+)/g;
                        const percentRegOutput = dat.match(percentRegex);
                        if (percentRegOutput) {
                            for (const item of percentRegOutput) {
                                const perc = Number(item);
                                progress?.report(
                                    {
                                        increment: perc - currentProgress,
                                        message: `${perc}%`
                                    }
                                );
                                currentProgress = perc;
                            }
                        } else {
                            const divisionRegOutput = divisionRegex.exec(dat);
                            if (divisionRegOutput) {
                                const perc = Math.ceil(parseInt(divisionRegOutput[1]) / parseInt(divisionRegOutput[2]) * 100);
                                progress?.report(
                                    {
                                        increment: perc - currentProgress,
                                        message: `${perc}%`
                                    }
                                );
                                currentProgress = perc;
                            }
                        }

                        if (token?.isCancellationRequested) {
                            if (childProcess) {
                                resolve(childProcess);
                            }
                        } else {
                            if (args.callback(dat, childProcess)) {
                                if (childProcess) {
                                    resolve(childProcess);
                                }
                            }
                        }
                    }
                );

                childProcess.stderr.on('data', (data: Buffer) => {
                    const dat = data.toString('utf8');
                    if (printOutput) {
                        this.rMarkdownOutput.appendLine(dat);
                    }
                });

                childProcess.on('exit', (code, signal) => {
                    this.rMarkdownOutput.appendLine(`[VSC-R] ${fileName} process exited ` +
                        (signal ? `from signal '${signal}'` : `with exit code ${code || 'null'}`));
                    if (code !== 0) {
                        reject({ cp: childProcess, wasCancelled: false });
                    }
                });

                token?.onCancellationRequested(() => {
                    reject({ cp: childProcess, wasCancelled: true });
                });
            }
        );
    }

    protected async knitWithProgress(args: IKnitArgs): Promise<DisposableProcess | undefined> {
        let childProcess: DisposableProcess | undefined = undefined;
        await util.doWithProgress(
            (async (
                token: vscode.CancellationToken | undefined,
                progress: vscode.Progress<{
                    message?: string | undefined;
                    increment?: number | undefined;
                }> | undefined) => {
                childProcess = await this.knitDocument(args, token, progress) as DisposableProcess;
            }),
            vscode.ProgressLocation.Notification,
            `Knitting ${args.fileName} ${args.rOutputFormat ? 'to ' + args.rOutputFormat : ''} `,
            true
        ).catch((rejection: IKnitRejection) => {
            if (!rejection.wasCancelled) {
                void vscode.window.showErrorMessage('There was an error in knitting the document. Please check the R Markdown output stream.');
                this.rMarkdownOutput.show(true);
            }
            // this can occur when a successfuly knitted document is later altered (while still being previewed) and subsequently fails to knit
            args?.onRejection?.(args.filePath, rejection);
            rejection.cp?.dispose();
        });
        return childProcess;
    }
}
