import * as util from '../util';
import * as vscode from 'vscode';
import * as cp from 'child_process';

import path = require('path');
import { readFileSync } from 'fs';
import yaml = require('js-yaml');

interface IKnitQuickPickItem {
	label: string,
	description: string,
	value: string
}

interface IKnitArgs {
	filePath: string;
	fileName: string;
	cmd: string;
	cb: (...args: unknown[]) => boolean;
	onRejection?: (...args: unknown[]) => unknown;
}

interface IKnitRejection {
	cp: cp.ChildProcessWithoutNullStreams;
	wasCancelled: boolean;
}

const rMarkdownOutput: vscode.OutputChannel = vscode.window.createOutputChannel('R Markdown');
export let knitDir: string = util.config().get<string>('rmarkdown.defaults.knitDirectory') ?? undefined;

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

	protected async knitDocument (args: IKnitArgs, token?: vscode.CancellationToken): Promise<cp.ChildProcessWithoutNullStreams | IKnitRejection> {
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
							if (args.cb(dat, childProcess)) {
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
			if (args.onRejection) {
				args.onRejection(args.filePath);
			} else {
				rejection.cp.kill('SIGKILL');
			}
		});
		return childProcess;
	}
}

export class RMarkdownKnitManager extends RMarkdownManager {

	private async renderDocument(docPath: string, docName: string, yamlParams: Record<string, unknown>, outputFormat?: string) {
		const dirOpts = this.getKnitDir(knitDir);
		let knitCommand: string;

		// precedence:
		// knit > site > none
		if (yamlParams?.['knit']) {
			const knitParam = String(yamlParams['knit']);
			knitCommand = `${knitParam}(${docPath})`;
		} else if (yamlParams?.['site']) {
			knitCommand = `rmarkdown::render_site(${docPath})`;
		} else {
			knitCommand = outputFormat ?
				`rmarkdown::render(${docPath}, output_format = ${outputFormat}())` :
				`rmarkdown::render(${docPath})`;
		}

		const shellCommand = `{library(rmarkdown); ${dirOpts.replace(/"/g, '\\"')}; ${knitCommand.replace(/"/g, '\\"')};}`;

		const lim = '---vsc---';
		const re = new RegExp(`.*${lim}(.*)${lim}.*`, 'ms');
		const cmd = (
			`${this.rPath} --silent --slave --no-save --no-restore -e ` +
			`"cat('${lim}', ${shellCommand}` +
			`, '${lim}', sep ='')"`
		);
		const callback = (dat: string) => {
			const outputUrl = re.exec(dat)?.[0]?.replace(re, '$1');
			if (outputUrl) {
				const outFile = (vscode.Uri.file(outputUrl));
				void vscode.commands.executeCommand('vscode.open', outFile);
				return true;
			} else {
				return false;
			}
		};

		await this.knitWithProgress(
			{
				fileName: docName,
				filePath: docPath,
				cmd: cmd,
				cb: callback
			}
		);

	}

	// alters the working directory for evaluating chunks
	public setKnitDir(): void {
		const items: IKnitQuickPickItem[] = [
			{
				label: knitDir === 'document directory' ? '$(check) document directory' : 'document directory',
				value: 'document directory',
				description: 'Use the document\'s directory as the knit directory'
			},
			{
				label: knitDir === 'workspace root' ? '$(check) workspace root' : 'workspace root',
				value: 'workspace root',
				description: 'Use the workspace root as the knit directory'
			},
			{
				label: knitDir === 'current directory' ? '$(check) current directory' : 'current directory',
				value: 'current directory',
				description: 'Use the terminal\'s current working directory as the knit directory'
			}
		];

		const ops: vscode.QuickPickOptions = {
			title: 'Set knit directory',
			canPickMany: false,
			onDidSelectItem: (item: IKnitQuickPickItem) => {
				knitDir = item.value;
			}
		};

		void vscode.window.showQuickPick(
			items,
			ops
		);
	}

	public async knitRmd(echo: boolean, outputFormat?: string): Promise<void> {
		const wad: vscode.TextDocument = vscode.window.activeTextEditor.document;
		const isSaved = await util.saveDocument(wad);
		if (isSaved) {
			const yamlParams = this.getKnitParams(wad.uri.fsPath);
			let rPath = util.ToRStringLiteral(wad.fileName, '"');
			let encodingParam = util.config().get<string>('source.encoding');
			encodingParam = `encoding = "${encodingParam}"`;
			rPath = [rPath, encodingParam].join(', ');
			if (echo) {
				rPath = [rPath, 'echo = TRUE'].join(', ');
			}

			await this.renderDocument(
				rPath,
				path.basename(wad.uri.fsPath),
				yamlParams,
				outputFormat
			);
		}
	}
}
