import path = require('path');
import os = require('os');
import { TreeDataProvider, EventEmitter, TreeItemCollapsibleState, TreeItem, Event, Uri, window, workspace } from 'vscode';
import { runTextInTerm } from './rTerminal';
import { globalenv, sessionDir } from './session';
import { config } from './util';

interface WorkspaceAttr {
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

		function sortItems(a: WorkspaceItem, b: WorkspaceItem) {
			const priorityAttr: string[] = [
				'data.frame',
				'list',
				'environment',
				'data.table',
				'tibble',
				'tbl_df',
				'tbl'
			]

			return priorityAttr.includes(a.contextValue) > priorityAttr.includes(b.contextValue) ? -1 : priorityAttr.includes(b.contextValue) > priorityAttr.includes(a.contextValue) ? 1 : 0 || a.label.localeCompare(b.label) || a.contextValue.localeCompare(b.contextValue);
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
		collapsibleState: TreeItemCollapsibleState
	) {
		super(label, collapsibleState);
		this.description = str;
		this.tooltip = `${label} (${rClass}, length of ${length})`;
		this.contextValue = rClass;
	}
}

export function clearWorkspace(): void {
	const removeHiddenItems: boolean = config().get('workspaceViewer.removeHiddenItems');
	void window.showInformationMessage(
		"Are you sure you want to clear the workspace? This cannot be reversed.",
		"Confirm",
		"Cancel"
	).then(selection => {
		if (selection == "Confirm") {
			if (removeHiddenItems) {
				void runTextInTerm(`rm(list = ls(all.names = TRUE))`)
			} else {
				void runTextInTerm(`rm(list = ls())`)
			}
		}
	})
}

export function saveWorkspace(): void {
	void window.showSaveDialog({
		defaultUri: Uri.file(getWorkspacePath() + path.sep + 'workspace'),
		filters: {
			'Data': ['RData']
		},
		title: 'Save workspace'
	}
	).then((uri: Uri | undefined) => {
		if (uri) {
			void runTextInTerm(
				`save.image("${(uri.fsPath.split(path.sep).join(path.posix.sep))}")`
			);
		}
	});
}

export function loadWorkspace(): void {
	void window.showOpenDialog({
		defaultUri: Uri.file(getWorkspacePath()),
		filters: {
			'Data': ['RData'],
		},
		title : 'Load workspace'
	}).then((uri: Uri[] | undefined) => {
		if (uri) {
			void runTextInTerm(
				`load("${(uri[0].fsPath.split(path.sep).join(path.posix.sep))}")`
			);
		}
	});
}

function getWorkspacePath(): string {
	// Check if there is an active file
	if (window.activeTextEditor) {
		// Check if workspace folders exist
		if (workspace.workspaceFolders) {
			// return current file's workspace folder
			return workspace.getWorkspaceFolder(window.activeTextEditor.document.uri).uri.fsPath;
		// Check if a filepath exists for current document
		} else if (window.activeTextEditor.document.uri.fsPath) {
			// return dir of current file
			return path.dirname(window.activeTextEditor.document.uri.fsPath)
		// Else return home dir
		} else {
			return os.homedir()
		}
	} else {
		// If workspace folders exist
		if (workspace.workspaceFolders) {
			// return first workspace folder
			return workspace.workspaceFolders?.map(folder => folder.uri.path)[0]
		} else {
			return os.homedir()
		}
	}
}
