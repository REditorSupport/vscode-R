import * as path from 'path';
import { TreeDataProvider, EventEmitter, TreeItemCollapsibleState, TreeItem, Event, Uri, window, ThemeIcon } from 'vscode';
import { runTextInTerm } from './rTerminal';
import { workspaceData, workingDir, WorkspaceData, GlobalEnv } from './session';
import { config } from './util';
import { isGuestSession, isLiveShare, UUID, guestWorkspace } from './liveShare';

const priorityAttr: string[] = [
	'list',
	'environment'
];

export class WorkspaceDataProvider implements TreeDataProvider<TreeItem> {
	private _onDidChangeTreeData: EventEmitter<void> = new EventEmitter();
	readonly onDidChangeTreeData: Event<void> = this._onDidChangeTreeData.event;

	refresh(): void {
		this.data = isGuestSession ? guestWorkspace : workspaceData;
		this._onDidChangeTreeData.fire();
	}

	data: WorkspaceData;

	private readonly treeItems: TreeItem[] = [];

	constructor() {
		const attachedNamespacesItem = new TreeItem('Attached Namespaces', TreeItemCollapsibleState.Collapsed);
		attachedNamespacesItem.id = 'attached-namespaces';
		attachedNamespacesItem.iconPath = new ThemeIcon('library');

		const loadedNamespacesItem = new TreeItem('Loaded Namespaces', TreeItemCollapsibleState.Collapsed);
		loadedNamespacesItem.id = 'loaded-namespaces';
		loadedNamespacesItem.iconPath = new ThemeIcon('package');

		const globalEnvItem = new TreeItem('Global Environment', TreeItemCollapsibleState.Expanded);
		globalEnvItem.id = 'globalenv';
		globalEnvItem.iconPath = new ThemeIcon('menu');

		this.treeItems.push(attachedNamespacesItem, loadedNamespacesItem, globalEnvItem);
	}

	getTreeItem(element: TreeItem): TreeItem {
		return element;
	}

	getChildren(element?: TreeItem): TreeItem[] {
		if (element) {
			if (this.data === undefined) {
				return [];
			}
			if (element.id === 'attached-namespaces') {
				return this.data.search.map(name => {
					const item = new TreeItem(name, TreeItemCollapsibleState.None);
					item.iconPath = new ThemeIcon(name.startsWith('package:') ? 'symbol-namespace' : 'symbol-array');
					return item;
				});
			} else if (element.id === 'loaded-namespaces') {
				return this.data.loaded_namespaces.map(name => {
					const item = new TreeItem(name, TreeItemCollapsibleState.None);
					item.iconPath = new ThemeIcon('symbol-namespace');
					return item;
				});
			} else if (element.id === 'globalenv') {
				return this.getGlobalEnvItems(this.data.globalenv);
			} else if (element instanceof GlobalEnvItem) {
				return element.str
					.split('\n')
					.filter((elem, index) => { return index > 0; })
					.map(strItem =>
						new GlobalEnvItem(
							'',
							'',
							strItem.replace(/\s+/g, ' ').trim(),
							'',
							0,
							element.treeLevel + 1
						)
					);
			}
		} else {
			return this.treeItems;
		}
	}

	private getGlobalEnvItems(globalenv: GlobalEnv): GlobalEnvItem[] {
		const toItem = (
			key: string,
			rClass: string,
			str: string,
			type: string,
			size?: number,
			dim?: number[]
		): GlobalEnvItem => {
			return new GlobalEnvItem(
				key,
				rClass,
				str,
				type,
				size,
				0,
				dim,
			);
		};

		const items = globalenv ? Object.keys(globalenv).map((key) =>
			toItem(
				key,
				globalenv[key].class[0],
				globalenv[key].str,
				globalenv[key].type,
				globalenv[key].size,
				globalenv[key].dim,
			)) : [];

		function sortItems(a: GlobalEnvItem, b: GlobalEnvItem) {
			if (priorityAttr.includes(a.type) > priorityAttr.includes(b.type)) {
				return -1;
			} else if (priorityAttr.includes(b.type) > priorityAttr.includes(a.type)) {
				return 1;
			} else {
				return 0 || a.label.localeCompare(b.label);
			}
		}

		return items.sort((a, b) => sortItems(a, b));
	}
}

export class GlobalEnvItem extends TreeItem {
	label: string;
	desc: string;
	str: string;
	type: string;
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
		super(label, GlobalEnvItem.setCollapsibleState(treeLevel, type, str));
		this.description = this.getDescription(dim, str, rClass, type);
		this.tooltip = this.getTooltip(label, rClass, size, treeLevel);
		this.iconPath = this.getIcon(type, dim);
		this.type = type;
		this.str = str;
		this.treeLevel = treeLevel;
		this.contextValue = treeLevel === 0 ? 'rootNode' : `childNode${treeLevel}`;
	}

	private getDescription(dim: number[], str: string, rClass: string, type: string): string {
		if (dim && type === 'list') {
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

	private getIcon(type: string, dim?: number[]) {
		let name: string;
		if (dim) {
			name = 'symbol-array';
		} else if (type === 'closure' || type === 'builtin') {
			name = 'symbol-function';
		} else if (type === '') {
			name = 'symbol-variable';
		} else {
			name = 'symbol-field';
		}
		return new ThemeIcon(name);
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

	if ((isGuestSession ? guestWorkspace : workspaceData) !== undefined) {
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
	if (workspaceData !== undefined) {
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
	if (workspaceData !== undefined) {
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
