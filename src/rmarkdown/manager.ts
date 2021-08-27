import * as util from '../util';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import path = require('path');

interface IKnitArgs {
	filePath: string;
	fileName: string;
	cmd: string;
	rCmd?: string;
	rOutputFormat?: string;
	callback: (...args: unknown[]) => boolean;
	onRejection?: (...args: unknown[]) => unknown;
}

export interface IKnitRejection {
	cp: cp.ChildProcessWithoutNullStreams;
	wasCancelled: boolean;
}

const rMarkdownOutput: vscode.OutputChannel = vscode.window.createOutputChannel('R Markdown');

export abstract class RMarkdownManager {
	protected rPath: string;
	protected rMarkdownOutput: vscode.OutputChannel = rMarkdownOutput;
	// uri that are in the process of knitting
	// so that we can't spam the knit/preview button
	protected busyUriStore: Set<string> = new Set<string>();

	public async init(): Promise<void> {
		this.rPath = await util.getRpath(true);
	}

	protected getKnitDir(knitDir: string): string {
		switch (knitDir) {
			// the directory containing the R Markdown document
			case 'document directory': {
				return path.dirname(vscode.window.activeTextEditor.document.uri.fsPath).replace(/"/g, '\\"');
			}
			// the root of the current workspace
			case 'workspace root': {
				return vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/"/g, '\\"');
			}
			// the working directory of the attached terminal, NYI
			// case 'current directory': {
			// 	return `knitr::opts_knit[["set"]](root.dir = NULL)`;
			// }
			default: return vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/"/g, '\\"');
		}
	}

	protected async knitDocument(args: IKnitArgs, token?: vscode.CancellationToken, progress?: vscode.Progress<unknown>): Promise<cp.ChildProcessWithoutNullStreams | IKnitRejection> {
		// vscode.Progress auto-increments progress, so we use this
		// variable to set progress to a specific number
		let currentProgress = 0;
		return await new Promise<cp.ChildProcessWithoutNullStreams>(
			(resolve, reject) => {
				const cmd = args.cmd;
				const fileName = args.fileName;
				let childProcess: cp.ChildProcessWithoutNullStreams;

				try {
					childProcess = cp.exec(cmd);
					progress.report({
						increment: 0,
						message: '0%'
					});
				} catch (e: unknown) {
					console.warn(`[VSC-R] error: ${e as string}`);
					reject({ cp: childProcess, wasCancelled: false });
				}

				this.rMarkdownOutput.appendLine(`[VSC-R] ${fileName} process started`);
				if (args.rCmd) {
					this.rMarkdownOutput.appendLine(`==> ${args.rCmd}`);
				}

				childProcess.stdout.on('data',
					(data: Buffer) => {
						const dat = data.toString('utf8');
						this.rMarkdownOutput.appendLine(dat);
						const percentRegex = /[0-9]+(?=%)/g;
						const percentRegOutput = dat.match(percentRegex);
						if (percentRegOutput) {
							for (const item of percentRegOutput) {
								const perc = Number(item);
								progress.report(
									{
										increment: perc - currentProgress,
										message: `${Math.round(perc)}%`
									}
								);
								currentProgress = perc;
							}
						}
						if (token?.isCancellationRequested) {
							resolve(childProcess);
						} else {
							if (args.callback(dat, childProcess)) {
								resolve(childProcess);
							}
						}
					}
				);

				childProcess.stderr.on('data', (data: Buffer) => {
					const dat = data.toString('utf8');
					this.rMarkdownOutput.appendLine(dat);
				});

				childProcess.on('exit', (code, signal) => {
					this.rMarkdownOutput.appendLine(`[VSC-R] ${fileName} process exited ` +
						(signal ? `from signal '${signal}'` : `with exit code ${code}`));
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

	protected async knitWithProgress(args: IKnitArgs): Promise<cp.ChildProcessWithoutNullStreams> {
		let childProcess: cp.ChildProcessWithoutNullStreams = undefined;

		await util.doWithProgress(async (token: vscode.CancellationToken, progress: vscode.Progress<unknown>) => {
			childProcess = await this.knitDocument(args, token, progress) as cp.ChildProcessWithoutNullStreams;
		},
			vscode.ProgressLocation.Notification,
			`Knitting ${args.fileName} ${args.rOutputFormat ? 'to ' + args.rOutputFormat : ''} `,
			true
		).catch((rejection: IKnitRejection) => {
			if (!rejection.wasCancelled) {
				void vscode.window.showErrorMessage('There was an error in knitting the document. Please check the R Markdown output stream.');
				this.rMarkdownOutput.show(true);
			}
			// this can occur when a successfuly knitted document is later altered (while still being previewed) and subsequently fails to knit
			args?.onRejection ? args.onRejection(args.filePath, rejection) :
				rejection?.cp.kill('SIGKILL');
		});
		return childProcess;
	}
}
