import * as util from '../util';
import * as vscode from 'vscode';
import path = require('path');
import { readFileSync } from 'fs';
import yaml = require('js-yaml');


interface IQuickPickItem {
	label: string,
	description: string,
	value: string
}

export class RMarkdownKnitManager {
	knitDir: string;

	constructor() {
		this.knitDir = util.config().get<string>('rmarkdown.defaults.knitDirectory') ?? undefined;
	}

	getKnitDir(): string {
		switch (this.knitDir) {
			case 'document directory': {
				return `knitr::opts_knit$set(root.dir = "${path.dirname(vscode.window.activeTextEditor.document.uri.fsPath)}")`;
			}
			case 'workspace root': {
				return `knitr::opts_knit$set(root.dir = "${vscode.workspace.workspaceFolders[0].uri.fsPath}")`;
			}
			case 'current directory': {
				return 'knitr::opts_knit$set(root.dir = getwd())';
			}
			default: return 'knitr::opts_knit$set(root.dir = NULL)';
		}
	}

	knitDocument(docPath: string, params: Record<string, any>, outputFormat?: string): void {
		const dirOpts = this.getKnitDir();
		let knitCommand: string;
		console.log(params);
		// knit param should have precedence
		if (params?.['knit']) {
			knitCommand = `${dirOpts}; ${String(params['knit'])}(${docPath});`;
		} else if (params?.['site']) {
			knitCommand = `${dirOpts}; rmarkdown::render_site(${docPath});`;
		} else {
			knitCommand = outputFormat ?
				`${dirOpts}; rmarkdown::render(${docPath}, ${outputFormat});` :
				`${dirOpts}; rmarkdown::render(${docPath});`;
		}

		const knitTask: vscode.Task = new vscode.Task({ type: 'R' }, vscode.TaskScope.Workspace, 'Knit', 'R', new vscode.ShellExecution(`Rscript -e "${knitCommand}"`));

		void vscode.tasks.executeTask(
			knitTask
		);
	}

	getParams(docPath: string) {
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

	public async knitRmd(echo: boolean, outputFormat?: string): Promise<void> {
		const wad: vscode.TextDocument = vscode.window.activeTextEditor.document;
		const isSaved = await util.saveDocument(wad);
		if (isSaved) {
			let rPath = util.ToRStringLiteral(wad.fileName, '"');
			let encodingParam = util.config().get<string>('source.encoding');
			encodingParam = `encoding = "${encodingParam}"`;
			rPath = [rPath, encodingParam].join(', ');
			if (echo) {
				rPath = [rPath, 'echo = TRUE'].join(', ');
			}
			const params = this.getParams(wad.uri.fsPath);
			this.knitDocument(rPath, params, outputFormat);
		}
	}

	public setKnitDir(): void {
		const items: IQuickPickItem[] = [
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
			onDidSelectItem: (item: IQuickPickItem) => {
				this.knitDir = item.value;
			}
		};

		void vscode.window.showQuickPick(
			items,
			ops
		);
	}


}
