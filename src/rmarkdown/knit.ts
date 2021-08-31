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

interface IYamlFrontmatter {
	title?: string,
	author?: string,
	knit?: string,
	site?: string,
	[key: string]: unknown
}

export class RMarkdownKnitManager extends RMarkdownManager {
	private async renderDocument(rPath: string, docPath: string, docName: string, yamlParams: IYamlFrontmatter, outputFormat?: string) {
		const openOutfile: boolean = util.config().get<boolean>('rmarkdown.knit.openOutputFile') ?? false;
		const knitWorkingDir = this.getKnitDir(knitDir, docPath);
		const knitCommand = await this.getKnitCommand(yamlParams, rPath, outputFormat);
		this.rPath = await util.getRpath(true);
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
				filePath: rPath,
				cmd: cmd,
				rCmd: knitCommand,
				rOutputFormat: outputFormat,
				callback: callback
			}
		);

	}

	private getYamlFrontmatter(docPath: string): IYamlFrontmatter {
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

	private async getKnitCommand(yamlParams: IYamlFrontmatter, docPath: string, outputFormat: string): Promise<string> {
		let knitCommand: string;

		if (!yamlParams?.['site']) {
			yamlParams['site'] = await this.findSiteParam();
		}

		// precedence:
		// knit > site > none
		if (yamlParams?.['knit']) {
			const knitParam = yamlParams['knit'];
			knitCommand = outputFormat ?
				`${knitParam}(${docPath}, output_format = '${outputFormat}')`:
				`${knitParam}(${docPath})`;
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

	// check if the workspace of the document is a R Markdown site.
	// the definition of what constitutes an R Markdown site differs
	// depending on the type of R Markdown site (i.e., "simple" vs. blogdown sites)
	private async findSiteParam(): Promise<string|undefined> {
		const rootFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
		const wad = vscode.window.activeTextEditor.document.uri.fsPath;
		const indexFile = (await vscode.workspace.findFiles(new vscode.RelativePattern(rootFolder, 'index.{Rmd,rmd, md}'), null, 1))?.[0];
		const siteRoot = path.join(path.dirname(wad), '_site.yml');

		// 'Simple' R Markdown websites require all docs to be in the root folder
		if (fs.existsSync(siteRoot)) {
			return 'rmarkdown::render_site';
		// Other generators may allow for docs in subdirs
		} else if (indexFile) {
			const indexData = this.getYamlFrontmatter(indexFile.fsPath);
			if (indexData?.['site']) {
				return indexData['site'];
			}
		}

		return undefined;
	}

	// readme files should not be knitted via render_site
	private isREADME(docPath: string) {
		return !!path.basename(docPath).includes('README');
	}

	// alters the working directory for evaluating chunks
	public setKnitDir(): void {
		const currentDocumentWorkspace = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
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
				description: currentDocumentWorkspace.uri.fsPath
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
					wad.uri.fsPath,
					path.basename(wad.uri.fsPath),
					this.getYamlFrontmatter(wad.uri.fsPath),
					outputFormat
				);
				this.busyUriStore.delete(busyPath);
			}

		}
	}
}
