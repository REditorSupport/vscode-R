import * as util from '../util';
import * as vscode from 'vscode';
import * as cp from 'child_process';

import { readFileSync } from 'fs';
import yaml = require('js-yaml');
import path = require('path');


interface IKnitArgs {
	filePath: string;
	fileName: string;
	cmd: string;
	cb: (...args: unknown[]) => boolean;
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

	public async init(): Promise<void> {
		this.rPath = await util.getRpath(true);
	}

	protected getKnitParams(docPath: string): Record<string, unknown> {
		const parseData = readFileSync(docPath, 'utf8');
		const yamlDat = /(?<=(---)).*(?=(---))/gs.exec(
			parseData
		);

		let paramObj = {};
		if (yamlDat) {
			try {
				paramObj = yaml.load(
					yamlDat[0]
				);
			} catch (e) {
				console.error(`Could not parse YAML frontmatter for "${docPath}". Error: ${String(e)}`);
			}
		}

		return paramObj;
	}

	protected getKnitDir(knitDir: string): string {
		switch (knitDir) {
			// the directory containing the R Markdown document
			case 'document directory': {
				return `knitr::opts_knit[["set"]](root.dir = "${path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)}")`;
			}
			// the root of the current workspace
			case 'workspace root': {
				return `knitr::opts_knit[["set"]](root.dir = "${vscode.workspace.workspaceFolders[0].uri.fsPath}")`;
			}
			// the working directory of the attached terminal
			case 'current directory': {
				return 'knitr::opts_knit[["set"]](root.dir = getwd())';
			}
			default: return 'knitr::opts_knit[["set"]](root.dir = NULL)';
		}
	}

	protected async knitDocument(args: IKnitArgs, token?: vscode.CancellationToken): Promise<cp.ChildProcessWithoutNullStreams | IKnitRejection> {
		return await new Promise<cp.ChildProcessWithoutNullStreams>(
			(resolve, reject) => {
				const cmd = args.cmd;
				const fileName = args.fileName;
				let childProcess: cp.ChildProcessWithoutNullStreams;

				try {
					childProcess = cp.exec(cmd);
				} catch (e: unknown) {
					console.warn(`[VSC-R] error: ${e as string}`);
					reject({ cp: childProcess, wasCancelled: false });
				}

				this.rMarkdownOutput.appendLine(`[VSC-R] ${fileName} process started`);

				childProcess.stdout.on('data',
					(data: Buffer) => {
						const dat = data.toString('utf8');
						this.rMarkdownOutput.appendLine(dat);
						if (token?.isCancellationRequested) {
							resolve(childProcess);
						} else {
							if (args?.cb(dat, childProcess)) {
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

		await util.doWithProgress(async (token: vscode.CancellationToken) => {
			childProcess = await this.knitDocument(args, token) as cp.ChildProcessWithoutNullStreams;
		},
			vscode.ProgressLocation.Notification,
			`Knitting ${args.fileName}...`,
			true
		).catch((rejection: {
			cp: cp.ChildProcessWithoutNullStreams,
			wasCancelled?: boolean
		}) => {
			if (!rejection.wasCancelled) {
				void vscode.window.showErrorMessage('There was an error in knitting the document. Please check the R Markdown output stream.');
				this.rMarkdownOutput.show(true);
			}
			// this can occur when a successfuly knitted document is later altered (while still being previewed) and subsequently fails to knit
			args?.onRejection(args.filePath, rejection);
		});
		return childProcess;
	}
}
