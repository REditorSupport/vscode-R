import * as path from 'path';
import { TreeDataProvider, EventEmitter, TreeItemCollapsibleState, TreeItem, Event, Uri, window } from 'vscode';
import { runTextInTerm } from './rTerminal';
import { globalenv, workingDir } from './session';
import { config } from './util';
import { isGuestSession, isLiveShare, UUID, guestGlobalenv } from './liveShare';

interface WorkspaceAttr {
	[key: string]: {
		class: string[];
		type: string;
		str: string;
		size?: number;
		dim?: number[]
	}
}

const priorityAttr: string[] = [
	'list',
	'environment'
];

export class WorkspaceDataProvider implements TreeDataProvider<WorkspaceItem> {
	private _onDidChangeTreeData: EventEmitter<void> = new EventEmitter();
	readonly onDidChangeTreeData: Event<void> = this._onDidChangeTreeData.event;

	refresh(): void {
		if (isGuestSession) {
			this.data = guestGlobalenv as WorkspaceAttr;
		} else {
			this.data = globalenv as WorkspaceAttr;
		}
		this._onDidChangeTreeData.fire();
	}

	data: WorkspaceAttr;

	getTreeItem(element: WorkspaceItem): TreeItem {
		return element;
	}

	getChildren(element?: WorkspaceItem): WorkspaceItem[] {
		if (element) {
			return element.str
				.split('\n')
				.filter((elem, index) => {return index > 0;})
				.map(strItem =>
					new WorkspaceItem(
						'',
						'',
						strItem.replace(/\s+/g,' ').trim(),
						'',
						0,
						element.treeLevel + 1
					)
				);
		} else {
			return this.getWorkspaceItems(this.data);
		}

	}

	private getWorkspaceItems(data: WorkspaceAttr): WorkspaceItem[] {
		const toItem = (
			key: string,
			rClass: string,
			str: string,
			type: string,
			size?: number,
			dim?: number[]
		): WorkspaceItem => {
			return new WorkspaceItem(
				key,
				rClass,
				str,
				type,
				size,
				0,
				dim,
			);
		};

		const items = data ? Object.keys(data).map((key) =>
			toItem(
				key,
				data[key].class[0],
				data[key].str,
				data[key].type,
				data[key].size,
				data[key].dim,
			)) : [];

		function sortItems(a: WorkspaceItem, b: WorkspaceItem) {
			if (priorityAttr.includes(a.contextValue) > priorityAttr.includes(b.contextValue)) {
				return -1;
			} else if (priorityAttr.includes(b.contextValue) > priorityAttr.includes(a.contextValue)) {
				return 1;
			} else {
				return 0 || a.label.localeCompare(b.label);
			}
		}

		return items.sort((a, b) => sortItems(a, b));
	}
}

export class WorkspaceItem extends TreeItem {
	label: string;
	desc: string;
	str: string;
	treeLevel: number;
	contextValue: string;

	constructor(
		label: string,
		rClass: string,
		str: string,
		type: string,
		size: number,
		treeLevel: number,
		dim?: number[],
	) {
		super(label, WorkspaceItem.setCollapsibleState(treeLevel, type, str));
		this.description = this.getDescription(dim, str, rClass);
		this.tooltip = this.getTooltip(label, rClass, size, treeLevel);
		this.contextValue = type;
		this.str = str;
		this.treeLevel = treeLevel;
		this.contextValue = treeLevel === 0 ? 'rootNode' : `childNode${treeLevel}`;
	}

	private getDescription(dim: number[], str: string, rClass: string): string {
		if (dim !== undefined) {
			if (dim[1] === 1) {
				return `${rClass}: ${dim[0]} obs. of ${dim[1]} variable`;
			} else {
				return `${rClass}: ${dim[0]} obs. of ${dim[1]} variables`;
			}
		} else {
			return str;
		}
	}

	private getSizeString(bytes: number): string {
		if (bytes < 1024) {
			return `${bytes} bytes`;
		} else {
			const e = Math.floor(Math.log(bytes) / Math.log(1024));
			return (bytes / Math.pow(1024, e)).toFixed(0) + 'KMGTP'.charAt(e - 1) + 'b';
		}
	}

	private getTooltip(label:string, rClass: string,
				size: number, treeLevel: number): string {
		if (size !== undefined && treeLevel === 0) {
			return `${label} (${rClass}, ${this.getSizeString(size)})`;
		} else if (treeLevel === 1) {
			return null;
		} else {
			return `${label} (${rClass})`;
		}
	}

	/* This logic has to be implemented this way to allow it to be called
	during the super constructor above. I created it to give full control
	of what elements can have have 'child' nodes os not. It can be expanded
	in the futere for more tree levels.*/

	private static setCollapsibleState(treeLevel: number, type: string, str: string) {
		if (treeLevel === 0 && priorityAttr.includes(type) && str.includes('\n')){
			return TreeItemCollapsibleState.Collapsed;
		} else {
			return TreeItemCollapsibleState.None;
		}
	}
}

export function clearWorkspace(): void {
	const removeHiddenItems: boolean = config().get('workspaceViewer.removeHiddenItems');
	const promptUser: boolean = config().get('workspaceViewer.clearPrompt');

	if ((isGuestSession ? guestGlobalenv : globalenv) !== undefined) {
		if (promptUser) {
			void window.showInformationMessage(
				'Are you sure you want to clear the workspace? This cannot be reversed.',
				'Confirm',
				'Cancel'
			).then(selection => {
				if (selection === 'Confirm') {
					clear();
				}
			});
		} else {
			clear();
		}
	}

	function clear() {
		const hiddenText = 'rm(list = ls(all.names = TRUE))';
		const text = 'rm(list = ls())';
		if (removeHiddenItems) {
			void runTextInTerm(`${hiddenText}`);
		} else {
			void runTextInTerm(`${text}`);
		}
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
		).then(async (uri: Uri | undefined) => {
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
			title: 'Load workspace'
		}).then(async (uri: Uri[] | undefined) => {
			if (uri) {
				const savePath = uri[0].fsPath.split(path.sep).join(path.posix.sep);
				return runTextInTerm(
					`load("${(savePath)}")`
				);
			}
		});
	}
}

export function viewItem(node: string): void {
	if (isLiveShare()) {
		void runTextInTerm(`View(${node}, uuid = ${UUID})`);
	} else {
		void runTextInTerm(`View(${node})`);
	}
}

export function removeItem(node: string): void {
	void runTextInTerm(`rm(${node})`);
}
