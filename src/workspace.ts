import path = require('path');
import { TreeDataProvider, EventEmitter, TreeItemCollapsibleState, TreeItem, Event, Uri, window } from 'vscode';
import { runTextInTerm } from './rTerminal';
import { globalenv } from './session';

export interface WorkspaceAttr {
    [key: string]: {
        class: string[];
        type: string;
        length: number;
        str: string;
    }
}

export class WorkspaceDataProvider implements TreeDataProvider<WorkspaceItem> {
	private _onDidChangeTreeData: EventEmitter<void> = new EventEmitter();
	readonly onDidChangeTreeData: Event<void> = this._onDidChangeTreeData.event;

	refresh(): void {
		this.data = <WorkspaceAttr> globalenv;
		this._onDidChangeTreeData.fire();
	}

	data: WorkspaceAttr;

	getTreeItem(element: WorkspaceItem): TreeItem {
		return element;
	}

	getChildren(): WorkspaceItem[] {
		return this.getWorkspaceItems(this.data);
	}

	private getWorkspaceItems(data: WorkspaceAttr): WorkspaceItem[] {
		const toItem = (
			key: string,
			rClass: string,
			str: string,
			type: string,
			length: number
		): WorkspaceItem => {
			return new WorkspaceItem(
				key,
				rClass,
				str,
				type,
				length,
				TreeItemCollapsibleState.None
			);
		};

		const items = data ? Object.keys(data).map((key) =>
			toItem(
				key,
				data[key].class[0],
				data[key].str,
				data[key].type,
				data[key].length
			)) : [];

		return items;
	}
}

export class WorkspaceItem extends TreeItem {
	constructor(
		label: string,
		rClass: string,
		str: string,
		type: string,
		length: number,
		collapsibleState: TreeItemCollapsibleState
	) {
		super(label, collapsibleState);
		this.description = str;
		this.tooltip = `${label} (${rClass}, length of ${length})`;
	}
}

export function saveWorkspace(): void {
	window.showSaveDialog({
		defaultUri: Uri.file('workspace.RData'),
		filters: {
			'Data': ['RData']
		}
	}
	).then((uri: Uri | undefined) => {
		if (uri) {
			runTextInTerm(
				`save.image(\"${(uri.fsPath.split(path.sep).join(path.posix.sep))}\")`
			);
		}
	});
}

export function loadWorkspace(): void {
	window.showOpenDialog({
		filters: {
			'Data': ['RData']
		}
	}).then((uri: Uri[] | undefined) => {
		if (uri) {
			runTextInTerm(
				`load(\"${(uri[0].fsPath.split(path.sep).join(path.posix.sep))}\")`
			);
		}
	});
}
