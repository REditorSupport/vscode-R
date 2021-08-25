import * as util from '../util';
import * as vscode from 'vscode';

import path = require('path');
import { readFileSync } from 'fs';
import yaml = require('js-yaml');
import { IKnitRejection, RMarkdownManager } from './manager';

export let knitDir: string = util.config().get<string>('rmarkdown.knit.defaults.knitDirectory') ?? undefined;

interface IKnitQuickPickItem {
	label: string,
	description: string,
	detail: string,
	value: string
}

export class RMarkdownKnitManager extends RMarkdownManager {

	private async renderDocument(docPath: string, docName: string, yamlParams: Record<string, unknown>, outputFormat?: string) {
		const dirOpts = this.getKnitDir(knitDir);
		const openOutfile: boolean = util.config().get<boolean>('rmarkdown.knit.openOutputFile') ?? false;
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
				if (openOutfile) {
					const outFile = (vscode.Uri.file(outputUrl));
					void vscode.commands.executeCommand('vscode.open', outFile);
				}
				return true;
			} else {
				return false;
			}
		};

		if (util.config().get<boolean>('rmarkdown.knit.focusOutputChannel')) {
			this.rMarkdownOutput.show();
		}

		await this.knitWithProgress(
			{
				fileName: docName,
				filePath: docPath,
				cmd: cmd,
				callback: callback,
				onRejection: (_filePath: string, rejection: IKnitRejection) => {
					rejection.cp.kill('SIGKILL');
				}
			}
		);

	}

	private getKnitParams(docPath: string): Record<string, unknown> {
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

	// alters the working directory for evaluating chunks
	public setKnitDir(): void {
		const items: IKnitQuickPickItem[] = [
			{
				label: knitDir === 'document directory' ? '$(check) document directory' : 'document directory',
				value: 'document directory',
				detail: 'Use the document\'s directory as the knit directory',
				description: path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)

			},
			{
				label: knitDir === 'workspace root' ? '$(check) workspace root' : 'workspace root',
				value: 'workspace root',
				detail: 'Use the workspace root as the knit directory',
				description: vscode.workspace.workspaceFolders[0].uri.fsPath
			}
			// {
			// 	label: knitDir === 'current directory' ? '$(check) current directory' : 'current directory',
			// 	value: 'current directory',
			// 	detail: 'Use the terminal\'s current working directory as the knit directory',
			// 	description: 'Not yet implemented'
			// }
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
