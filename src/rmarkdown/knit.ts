import * as util from '../util';
import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import path = require('path');
import yaml = require('js-yaml');

import { RMarkdownManager } from './manager';

export let knitDir: string = util.config().get<string>('rmarkdown.knit.defaults.knitDirectory') ?? undefined;

interface IKnitQuickPickItem {
	label: string,
	description: string,
	detail: string,
	value: string
}

export class RMarkdownKnitManager extends RMarkdownManager {
	private async renderDocument(docPath: string, docName: string, yamlParams: Record<string, unknown>, outputFormat?: string) {
		const knitWorkingDir = this.getKnitDir(knitDir);
		const openOutfile: boolean = util.config().get<boolean>('rmarkdown.knit.openOutputFile') ?? false;
		let knitCommand: string;

		// precedence:
		// knit > site > none
		if (yamlParams?.['knit']) {
			const knitParam = String(yamlParams['knit']);
			knitCommand = `${knitParam}(${docPath})`;
		} else if (!outputFormat && (yamlParams?.['site'] || this.isSiteWorkspace())) {
			knitCommand = `rmarkdown::render_site(${docPath})`;
		} else {
			knitCommand = outputFormat ?
				`rmarkdown::render(${docPath}, output_format = '${outputFormat}')` :
				`rmarkdown::render(${docPath})`;
		}

		const shellCommand = `${knitCommand.replace(/"/g, '\\"')}`;
		const lim = '---vsc---';
		const re = new RegExp(`.*${lim}(.*)${lim}.*`, 'gms');
		const cmd = (
			`${this.rPath} --silent --slave --no-save --no-restore -e ` +
			`"${knitWorkingDir.replace(/"/g, '\\"')};` +
			`cat('${lim}', ${shellCommand},` +
			`'${lim}',` +
			`sep = '')"`
		);
		const callback = (dat: string) => {
			const outputUrl = re.exec(dat)?.[0].replace(re, '$1');
			if (outputUrl) {
				if (openOutfile) {
					const outFile = vscode.Uri.file(outputUrl);
					void vscode.commands.executeCommand('vscode.open', outFile);
				}
				return true;
			} else {
				return false;
			}
		};

		if (util.config().get<boolean>('rmarkdown.knit.focusOutputChannel')) {
			this.rMarkdownOutput.show(true);
		}

		return await this.knitWithProgress(
			{
				fileName: docName,
				filePath: docPath,
				cmd: cmd,
				rCmd: knitCommand,
				rOutputFormat: outputFormat,
				callback: callback
			}
		);

	}

	private getYamlFrontmatter(docPath: string): Record<string, unknown> {
		const parseData = fs.readFileSync(docPath, 'utf8');
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

	// check if the workspace of the document is a R Markdown site
	// as indicated by the presence of an index + _site.yml file
	private isSiteWorkspace() {
		const rootFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
		const indexRmd = path.join(rootFolder, 'index.Rmd');
		const indexMd = path.join(rootFolder, 'index.md');
		const siteYaml = path.join(rootFolder, '_site.yml');

		if (fs.existsSync(siteYaml) && (fs.existsSync(indexRmd) || fs.existsSync(indexMd))) {
			return true;
		}
		return false;
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

		// handle untitled rmd
		if (vscode.window.activeTextEditor.document.isUntitled) {
			void vscode.window.showWarningMessage('Cannot knit an untitled file. Please save the document.');
			await vscode.commands.executeCommand('workbench.action.files.save').then(() => {
				if (!vscode.window.activeTextEditor.document.isUntitled) {
					void this.knitRmd(echo, outputFormat);
				}
			});
			return;
		}

		const isSaved = await util.saveDocument(wad);
		if (isSaved) {
			const yamlParams = this.getYamlFrontmatter(wad.uri.fsPath);
			let rPath = util.ToRStringLiteral(wad.fileName, '"');
			let encodingParam = util.config().get<string>('source.encoding');
			encodingParam = `encoding = "${encodingParam}"`;
			rPath = [rPath, encodingParam].join(', ');
			if (echo) {
				rPath = [rPath, 'echo = TRUE'].join(', ');
			}

			const busyPath = wad.uri.fsPath + outputFormat;
			if (this.busyUriStore.has(busyPath)) {
				return;
			} else {
				this.busyUriStore.add(busyPath);
				await this.renderDocument(
					rPath,
					path.basename(wad.uri.fsPath),
					yamlParams,
					outputFormat
				);
				this.busyUriStore.delete(busyPath);
			}

		}
	}
}
