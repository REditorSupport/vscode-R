import * as util from '../util';
import * as vscode from 'vscode';

import path = require('path');
import { readFileSync } from 'fs';
import yaml = require('js-yaml');


interface IKnitQuickPickItem {
	label: string,
	description: string,
	value: string
}

export class RMarkdownKnitManager {
	private knitDir: string;

	constructor() {
		this.knitDir = util.config().get<string>('rmarkdown.defaults.knitDirectory') ?? undefined;
	}

	private getKnitDir(): string {
		switch (this.knitDir) {
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

	private knitDocument(docPath: string, params: Record<string, unknown>, outputFormat?: string): void {
		const dirOpts = this.getKnitDir();
		let knitCommand: string;

		// precedence:
		// knit > site > none
		if (params?.['knit']) {
			const knitParam = String(params['knit']);
			knitCommand = outputFormat ?
				`out <- ${knitParam}(${docPath}, output_format = ${outputFormat}())` :
				`out <- ${knitParam}(${docPath})`;
		} else if (params?.['site']) {
			knitCommand = `out <- rmarkdown::render_site(${docPath})`;
		} else {
			knitCommand = outputFormat ?
				`out <- rmarkdown::render(${docPath}, output_format = ${outputFormat}())` :
				`out <- rmarkdown::render(${docPath})`;
		}

		const knitTask: vscode.Task = new vscode.Task(
			{ type: 'R' },
			vscode.TaskScope.Workspace,
			'Knit',
			'R',
			new vscode.ShellExecution(
				`Rscript --verbose -e "library(rmarkdown); ${dirOpts.replace(/"/g, '\\"')}" -e "${knitCommand.replace(/"/g, '\\"')
				}; browseURL(out)"`
			)
		);

		void vscode.tasks.executeTask(
			knitTask
		);
	}

	private getParams(docPath: string): Record<string, unknown> {
		const parseData = readFileSync(docPath, 'utf8');
		const delims = /(?<=(---)).*(?=(---))/gs.exec(
			parseData
		);

		let paramObj = {};
		try {
			paramObj = yaml.load(
				delims[0]
			);
		} catch(e) {
			console.error(`Could not parse YAML frontmatter for "${docPath}". Error: ${String(e)}`);
		}

		return paramObj;
	}

	// alters the working directory for evaluating chunks
	public setKnitDir(): void {
		const items: IKnitQuickPickItem[] = [
			{
				label: this.knitDir === 'document directory' ? '$(check) document directory' : 'document directory',
				value: 'document directory',
				description: 'Use the document\'s directory as the knit directory'
			},
			{
				label: this.knitDir === 'workspace root' ? '$(check) workspace root' : 'workspace root',
				value: 'workspace root',
				description: 'Use the workspace root as the knit directory'
			},
			{
				label: this.knitDir === 'current directory' ? '$(check) current directory' : 'current directory',
				value: 'current directory',
				description: 'Use the terminal\'s current working directory as the knit directory'
			}
		];

		const ops: vscode.QuickPickOptions = {
			title: 'Set knit directory',
			canPickMany: false,
			onDidSelectItem: (item: IKnitQuickPickItem) => {
				this.knitDir = item.value;
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
			const params = this.getParams(wad.uri.fsPath);
			let rPath = util.ToRStringLiteral(wad.fileName, '"');
			let encodingParam = util.config().get<string>('source.encoding');
			encodingParam = `encoding = "${encodingParam}"`;
			rPath = [rPath, encodingParam].join(', ');
			if (echo) {
				rPath = [rPath, 'echo = TRUE'].join(', ');
			}

			this.knitDocument(rPath, params, outputFormat);
		}
	}
}
