import path = require('path');
import { TreeDataProvider, EventEmitter, TreeItemCollapsibleState, TreeItem, Event, Uri, window } from 'vscode';
import { runTextInTerm } from './rTerminal';
import { globalenv, workingDir } from './session';
import { config } from './util';

interface WorkspaceAttr {
    [key: string]: {
        class: string[];
        type: string;
        length: number;
		str: string;
		dim?: number[]
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
			length: number,
			dim?: number[]
		): WorkspaceItem => {
			return new WorkspaceItem(
				key,
				rClass,
				str,
				type,
				length,
				TreeItemCollapsibleState.None,
				dim,
			);
		};

		const items = data ? Object.keys(data).map((key) =>
			toItem(
				key,
				data[key].class[0],
				data[key].str,
				data[key].type,
				data[key].length,
				data[key].dim,
			)) : [];

		function sortItems(a: WorkspaceItem, b: WorkspaceItem) {
			const priorityAttr: string[] = [
				'list',
				'environment'
			]

			if (priorityAttr.includes(a.contextValue) > priorityAttr.includes(b.contextValue)) {
				return -1
			} else if (priorityAttr.includes(b.contextValue) > priorityAttr.includes(a.contextValue)) {
				return 1
			} else {
				return 0 || a.label.localeCompare(b.label);
			}
		}

		return items.sort((a, b) => sortItems(a, b));
	}
}

export class WorkspaceItem extends TreeItem {
	constructor(
		label: string,
		rClass: string,
		str: string,
		type: string,
		length: number,
		collapsibleState: TreeItemCollapsibleState,
		dim?: number[]
	) {
		super(label, collapsibleState);
		this.description = this.getDescription(dim, str);
		this.tooltip = `${label} (${rClass}, length of ${length})`;
		this.contextValue = type;
	}

	private getDescription(dim: number[], str: string): string {
		if (dim !== undefined) {
			return `${dim[0]} obs. of ${dim[1]} variables`
		} else {
			return str
		}
	}
}

export function clearWorkspace(): void {
	const removeHiddenItems: boolean = config().get('workspaceViewer.removeHiddenItems');
	if (globalenv !== undefined) {
		void window.showInformationMessage(
			'Are you sure you want to clear the workspace? This cannot be reversed.',
			'Confirm',
			'Cancel'
		).then(selection => {
			if (selection === 'Confirm') {
				if (removeHiddenItems) {
					return runTextInTerm(`rm(list = ls(all.names = TRUE))`)
				} else {
					return runTextInTerm(`rm(list = ls())`)
				}
			}
		})
	}
}

export function saveWorkspace(): void {
	if (globalenv !== undefined) {
		void window.showSaveDialog({
			defaultUri: Uri.file(`${workingDir}${path.sep}workspace.RData`),
			filters: {
				'Data': ['RData']
			},
			title: 'Save workspace'
		}
		).then((uri: Uri | undefined) => {
			if (uri) {
				return runTextInTerm(
					`save.image("${(uri.fsPath.split(path.sep).join(path.posix.sep))}")`
				);
			}
		});
	}
}

export function loadWorkspace(): void {
	if (globalenv !== undefined) {
		void window.showOpenDialog({
			defaultUri: Uri.file(workingDir),
			filters: {
				'Data': ['RData'],
			},
			title : 'Load workspace'
		}).then((uri: Uri[] | undefined) => {
			if (uri) {
				return runTextInTerm(
					`load("${(uri[0].fsPath.split(path.sep).join(path.posix.sep))}")`
				);
			}
		});
	}
}
