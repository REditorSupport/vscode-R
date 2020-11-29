import { TreeDataProvider, EventEmitter, TreeItemCollapsibleState, TreeItem, ProviderResult, Event } from 'vscode';
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
	private _onDidChangeTreeData: EventEmitter<WorkspaceItem | undefined | null | void>
		= new EventEmitter<WorkspaceItem | undefined | null | void>();
	readonly onDidChangeTreeData: Event<WorkspaceItem | undefined | null | void>
		= this._onDidChangeTreeData.event;

	refresh(): void {
		this.data = globalenv;
		this._onDidChangeTreeData.fire();
	}

	data: WorkspaceAttr;

	constructor() {}

	getTreeItem(element: WorkspaceItem): TreeItem | Thenable<TreeItem> {
		return element;
	}

	getChildren(element?: WorkspaceItem): ProviderResult<WorkspaceItem[]> {
		return Promise.resolve(
			this.getWorkspaceItems(this.data));
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
				TreeItemCollapsibleState.None
			);
		};

		const items = data ? Object.keys(data).map((key) =>
			toItem(
				key,
				data[key].class,
				data[key].type,
				data[key].str,
				data[key].length
			)) : [];

		return items;
	}
}

export class WorkspaceItem extends TreeItem {
	constructor(
		label: string,
		rClass: string[],
		type: string,
		typeDetailed: string,
		length: number,
		collapsibleState: TreeItemCollapsibleState
	) {
		super(label, collapsibleState);
		this.description = typeDetailed;
		this.tooltip = `${label} (${rClass}, length of ${length})`;
	}
}
