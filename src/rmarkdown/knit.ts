import * as util from '../util';
import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import path = require('path');
import yaml = require('js-yaml');

import { RMarkdownManager } from './manager';

export let knitDir: string = util.config().get<string>('rmarkdown.knit.defaults.knitWorkingDirectory') ?? undefined;

interface IKnitQuickPickItem {
	label: string,
	description: string,
	detail: string,
	value: string
}

export class RMarkdownKnitManager extends RMarkdownManager {
	private async renderDocument(docPath: string, docName: string, yamlParams: Record<string, unknown>, outputFormat?: string) {
		const openOutfile: boolean = util.config().get<boolean>('rmarkdown.knit.openOutputFile') ?? false;
		const knitWorkingDir = this.getKnitDir(knitDir);
		const knitCommand = await this.getKnitCommand(yamlParams, docPath, outputFormat);

		const lim = '---vsc---';
		const re = new RegExp(`.*${lim}(.*)${lim}.*`, 'gms');
		const cmd = (
			`${this.rPath} --silent --slave --no-save --no-restore -e ` +
			`"knitr::opts_knit[['set']](root.dir = '${knitWorkingDir}');` +
			`cat('${lim}', ${knitCommand},` +
			`'${lim}',` +
			`sep = '')"`
		);
		const callback = (dat: string) => {
			const outputUrl = re.exec(dat)?.[0]?.replace(re, '$1');
			if (outputUrl) {
				if (openOutfile) {
					const outFile = vscode.Uri.file(outputUrl);
					if (fs.existsSync(outFile.fsPath)) {
						void vscode.commands.executeCommand('vscode.open', outFile);
					} else {
						void vscode.window.showWarningMessage(`Could not find the output file at path: "${outFile.fsPath}"`);
					}
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

	private getYamlFrontmatter(docPath: string) {
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

	private async getKnitCommand(frontmatter: Record<string, unknown>, docPath: string, outputFormat: string): Promise<string> {
		const yamlParams = frontmatter;
		let knitCommand: string;

		if (!yamlParams['site']) {
			yamlParams['site'] = await this.findSiteParam();
		}

		// precedence:
		// knit > site > none
		if (yamlParams?.['knit']) {
			const knitParam = String(yamlParams['knit']);
			knitCommand = `${knitParam}(${docPath})`;
		} else if (!this.isREADME(docPath) && yamlParams?.['site']) {
			knitCommand = outputFormat ?
				`rmarkdown::render_site(${docPath}, output_format = '${outputFormat}')` :
				`rmarkdown::render_site(${docPath})`;
		} else {
			knitCommand = outputFormat ?
				`rmarkdown::render(${docPath}, output_format = '${outputFormat}')` :
				`rmarkdown::render(${docPath})`;
		}

		return knitCommand.replace(/"/g, '\\"');
	}

	// check if the workspace of the document is a R Markdown site
	private async findSiteParam(): Promise<string|undefined> {
		const rootFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
		const indexFile = (await vscode.workspace.findFiles(new vscode.RelativePattern(rootFolder, 'index.{Rmd,rmd, md}'), null, 1))?.[0];
		const siteYaml = path.join(rootFolder, '_site.yml');

		if (indexFile) {
			const indexData = this.getYamlFrontmatter(indexFile.fsPath);
			if (indexData['site']) {
				return indexData['site'] as string;
			}
		} else if (fs.existsSync(siteYaml)) {
			return 'rmarkdown::render_site';
		}

		return undefined;
	}

	// readme files should not be knitted via render_site
	private isREADME(docPath: string) {
		return path.basename(docPath, '.Rmd') === 'README';
	}

	// alters the working directory for evaluating chunks
	public setKnitDir(): void {
		const items: IKnitQuickPickItem[] = [
			{
				label: knitDir === 'document directory' ? '$(check) document directory' : 'document directory',
				value: 'document directory',
				detail: 'Use the document\'s directory as the knit working directory',
				description: path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)

			},
			{
				label: knitDir === 'workspace root' ? '$(check) workspace root' : 'workspace root',
				value: 'workspace root',
				detail: 'Use the workspace root as the knit working directory',
				description: vscode.workspace.workspaceFolders[0].uri.fsPath
			}
			// {
			// 	label: knitDir === 'current directory' ? '$(check) current directory' : 'current directory',
			// 	value: 'current directory',
			// 	detail: 'Use the terminal\'s current working directory as the knit directory',
			// 	description: 'Not yet implemented'
			// }
		];

		void vscode.window.showQuickPick(
			items,
			{
				title: 'Set knit working directory',
				canPickMany: false,
				onDidSelectItem: (item: IKnitQuickPickItem) => {
					knitDir = item.value;
				}
			}
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
					this.getYamlFrontmatter(wad.uri.fsPath),
					outputFormat
				);
				this.busyUriStore.delete(busyPath);
			}

		}
	}
}
