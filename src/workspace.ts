import * as vscode from 'vscode';
import { globalenv } from './session';

export interface WorkspaceAttr {
    [key: string]: {
        class: string[];
        type: string;
        length: number;
        str: string;
    }
}

const workspace: WorkspaceAttr = globalenv;

export class WorkspaceDataProvider implements vscode.TreeDataProvider<WorkspaceItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<
		WorkspaceItem | undefined | null | void
	> = new vscode.EventEmitter<WorkspaceItem | undefined | null | void>();
	readonly onDidChangeTreeData: vscode.Event<
		WorkspaceItem | undefined | null | void
	> = this._onDidChangeTreeData.event;

	refresh(): void {
		this.data = globalenv;
		this._onDidChangeTreeData.fire();
	}

	data: WorkspaceAttr;

	constructor() {
		this.data = workspace;
		console.log(this.data);
	}

	getTreeItem(
		element: WorkspaceItem
	): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
	}

	getChildren(
		element?: WorkspaceItem
	): vscode.ProviderResult<WorkspaceItem[]> {
		return Promise.resolve(this.getWorkspaceItems(this.data));
	}

	private getWorkspaceItems(data: any): WorkspaceItem[] {
		const toItem = (
			key: string,
			rClass: string[],
			type: string,
			typeDetailed: string,
			length: number
		): WorkspaceItem => {
			return new WorkspaceItem(
				key,
				rClass,
				type,
				typeDetailed,
				length,
				vscode.TreeItemCollapsibleState.None
			);
		};

		const items = data
			? Object.keys(data).map((item) =>
					toItem(item, data[item].class, data[item].type, data[item].str, data[item].length)
			  ) : [];
		return items;
	}
}

export class WorkspaceItem extends vscode.TreeItem {
	constructor(
		label: string,
		rClass: string[],
		type: string,
		typeDetailed: string,
		length: number,
		collapsibleState: vscode.TreeItemCollapsibleState
	) {
		super(label, collapsibleState);
		this.description = typeDetailed;
		this.tooltip = `${label} (${rClass}, length of ${length})`;
	}
}
