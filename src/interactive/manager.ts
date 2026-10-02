import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AgentClient } from './client';
import { AgentConfig, AgentSnapshot, DEFAULT_MAX_ASSET_BYTES, ExecutionRecord, SessionEvent, SessionManifest, SourceLocation, object, sessionLabel } from './protocol';
import { AssetStore, AssetStorageStats, exportedAssetName, readAsset } from './assets';
import { defaultStorage, discoverSessions, hasSessionEndpoint, installRuntime, launchAgent, newIdentity, prepareNodeRuntime } from './launcher';
import { discoverArf, probeArfSession, ArfSession } from './arf';
import { resolveArfExecutable } from './arfExecutable';
import { prepareSupervisor } from './supervisor';
import { Transcript, TranscriptCell } from './transcript';
import { DISPLAY_MIME, InteractiveSerializer } from './notebook';
import { setInteractiveExecutor } from './executionTarget';
import * as session from '../session';
import * as util from '../util';
import { escapeXml } from './plotSvg';
import { ensureWorkspaceViewer } from '../extension';
import { queryTablePage } from './tableQuery';
import { tableColumnAlignment, tableDisplayValue, tableSnapshotSummary } from './tableFormatting';
import { HistoryPage, searchHistory } from './history';
import { readExecutionRecords, readPreviousJournal } from './journal';
import { sessionAge, sessionPresentation } from './sessionPresentation';
import { runningSessions, stopSession } from './sessionLifecycle';

interface InteractiveView {
    client: AgentClient;
    target: session.Session;
    model: Transcript;
    history: Transcript[];
    notebook: vscode.NotebookDocument;
    controller: vscode.NotebookController;
    controllers: vscode.NotebookController[];
    inputUri?: vscode.Uri;
    executions: Map<string, { task: vscode.NotebookCellExecution; started: boolean }>;
    chain: Promise<void>;
    pending: Set<string>;
    timer?: NodeJS.Timeout;
    reconnectTimer?: NodeJS.Timeout;
    disposed: boolean;
    prompts: Set<number>;
    base: string;
    hidden: Set<string>;
    restarting?: boolean;
}

interface SessionChoice extends vscode.QuickPickItem { manifest?: SessionManifest; arf?: ArfSession; create?: boolean; terminal?: boolean }
interface SavedConnection { id: string; notebookUri?: string }

export class InteractiveManager implements vscode.Disposable, vscode.TreeDataProvider<SessionManifest> {
    private views = new Map<string, InteractiveView>();
    private opening = new Map<string, Promise<void>>();
    private presentationRefresh = new Set<InteractiveView>();
    private active?: InteractiveView;
    private routing = false;
    private targetSelection?: Promise<InteractiveView | 'createTerminal' | undefined>;
    private manifests: SessionManifest[] = [];
    private changes = new vscode.EventEmitter<SessionManifest | undefined>();
    readonly onDidChangeTreeData = this.changes.event;
    private disposables: vscode.Disposable[] = [];
    private output = vscode.window.createOutputChannel('R Interactive');
    private messages = vscode.notebooks.createRendererMessaging('r-interactive-renderer');
    private serializer = new InteractiveSerializer();
    private root: string;
    private closed = false;
    private clientId: string;
    private savedConnections: Map<string, SavedConnection>;
    private outputViews: Map<string, { tableView?: string; selectedPlot?: string }>;
    private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);

    constructor(private context: vscode.ExtensionContext) {
        this.root = util.config().get<string>('interactive.storagePath') || defaultStorage();
        this.clientId = randomUUID();
        // Native Interactive tabs restore their URI, but discard notebook metadata.
        // Keep that association outside the notebook, including while R is unreachable.
        const saved = context.workspaceState.get<SavedConnection[]>('r.interactive.connections') ??
            context.workspaceState.get<string[]>('r.interactive.sessions', []).map(id => ({ id }));
        this.savedConnections = new Map(saved.map(connection => [connection.id, connection]));
        this.outputViews = new Map(context.workspaceState.get('r.interactive.outputViews', []));
        const command = (name: string, handler: (...args: unknown[]) => unknown): void => {
            this.disposables.push(vscode.commands.registerCommand(name, (...args: unknown[]) =>
                Promise.resolve().then(() => handler(...args)).catch((error: unknown) => this.report(error))));
        };
        command('r.interactive.new', async () => {
            const view = await this.create();
            if (view) {
                if (view.inputUri) {
                    // Reuse the native editor created beside the previous input.
                    // showNotebookDocument would open a second tab in the old group.
                    await vscode.commands.executeCommand('interactive.open', { preserveFocus: false }, view.notebook.uri);
                    await vscode.commands.executeCommand('interactive.input.focus');
                } else {
                    const editor = vscode.window.visibleNotebookEditors.find(item => item.notebook === view.notebook);
                    await vscode.window.showNotebookDocument(view.notebook, { preserveFocus: false, viewColumn: editor?.viewColumn });
                }
            }
        });
        command('r.interactive.connect', () => this.pick());
        command('r.interactive.open', value => value ? this.open(value as SessionManifest) : this.pick());
        command('r.interactive.refresh', () => this.refresh());
        command('r.interactive.interrupt', value => this.forView(value, view => view.client.request('interrupt')));
        command('r.interactive.input', value => this.forView(value, view => this.resumeInput(view)));
        command('r.interactive.detach', value => this.forView(value, view => this.detach(view)));
        command('r.interactive.stop', value => this.forView(value, view => this.stop(view)));
        command('r.interactive.stopSelected', (value, selection) => this.stopMultiple(false, value, selection));
        command('r.interactive.stopAll', () => this.stopMultiple(true));
        command('r.interactive.restart', value => this.forView(value, view => this.restart(view)));
        command('r.interactive.sessionActions', value => this.forView(value, view => this.sessionActions(view)));
        command('r.interactive.takeControl', value => this.forView(value, async view => {
            view.client.control = await view.client.request<boolean>('claim', { force: true }); this.updateStatus(); this.changes.fire(undefined);
        }));
        command('r.interactive.rename', (value, label) => this.forView(value, view => this.rename(view, typeof label === 'string' ? label : undefined)));
        command('r.interactive.history', value => this.forView(value, view => this.history(view)));
        command('r.interactive.plots', value => this.forView(value, view => this.plots(view)));
        command('r.interactive.cancelQueued', value => this.forView(value, view => this.cancelQueued(view)));
        command('r.interactive.reuseCell', value => this.forView(value, async view => {
            const cell = value as vscode.NotebookCell;
            // Native Interactive toolbars do not expose notebookCellType, so
            // their actions also appear on lifecycle notices.
            if (cell.kind !== vscode.NotebookCellKind.Code) {
                void vscode.window.showInformationMessage('Select an R code cell to insert into the Interactive input.');
                return;
            }
            await this.insertCode(view, cell.document.getText());
        }));
        command('r.interactive.copyCell', value => vscode.env.clipboard.writeText((value as vscode.NotebookCell).document.getText()));
        command('r.interactive.source', value => {
            const cell = value as vscode.NotebookCell;
            if (cell.kind !== vscode.NotebookCellKind.Code) {
                void vscode.window.showInformationMessage('Session notices have no source location.');
                return;
            }
            return this.source(cell.metadata.rSource as SourceLocation | undefined);
        });
        command('r.interactive.info', value => this.forView(value, view => {
            this.output.appendLine(sessionPresentation(view.client.manifest, view.client.connected, view.client.control,
                view.restarting, view.target.workingDir).tooltip);
            this.output.show(true);
        }));
        command('r.interactive.useTerminal', () => { this.routing = false; });
        command('r.interactive.bindDocument', () => {
            const document = vscode.window.activeTextEditor?.document;
            if (document && this.active) { session.bindSessionDocument(document.uri, this.active.target); }
        });
        command('r.interactive.export', value => this.forView(value, view => this.exportHistory(view)));
        command('r.interactive.clear', value => this.forView(value, view => this.clearCompleted(view)));
        command('r.interactive.cleanAssets', value => this.forView(value, async view => {
            if (!view.client.manifest.capabilities.assetStorage) { throw new Error('Asset cleanup requires a session started with the current extension build'); }
            const stats = await view.client.request<AssetStorageStats>('assetStorage', { compact: true });
            void vscode.window.showInformationMessage(`R Interactive: reclaimed ${(stats.reclaimedBytes / 1024 / 1024).toFixed(1)} MiB. Retained assets use ${(stats.usedBytes / 1024 / 1024).toFixed(1)} MiB of ${(stats.limitBytes / 1024 / 1024 / 1024).toFixed(2)} GiB.`);
        }));
        this.status.name = 'R Interactive session'; this.status.command = 'r.interactive.connect';
        this.disposables.push(this.status);
        const ageTimer = setInterval(() => { this.changes.fire(undefined); this.updateStatus(); }, 60000);
        ageTimer.unref();
        this.disposables.push({ dispose: () => clearInterval(ageTimer) });
        this.disposables.push(vscode.window.createTreeView('rInteractiveSessions', { treeDataProvider: this, canSelectMany: true }),
            vscode.workspace.registerNotebookSerializer('r-interactive', this.serializer, { transientOutputs: false }),
            this.messages.onDidReceiveMessage(event => { void this.rendererMessage(event.editor, event.message as Record<string, unknown>); }),
            vscode.window.onDidChangeActiveNotebookEditor(editor => {
                const view = [...this.views.values()].find(item => item.notebook === editor?.notebook);
                void vscode.commands.executeCommand('setContext', 'r.interactive.notebook', !!view);
                if (view) { void this.activate(view); }
            }),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                const target = editor && session.boundSessionForDocument(editor.document.uri);
                const view = target && [...this.views.values()].find(item => item.target === target);
                if (view) { void this.activate(view); }
                else { this.updateStatus(); }
            }),
            vscode.workspace.onDidCloseNotebookDocument(document => {
                const view = [...this.views.values()].find(item => item.notebook === document);
                if (view) { this.disposeView(view); }
            }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('r.interactive.tableView')) {
                    for (const view of this.views.values()) {
                        view.chain = view.chain.then(async () => {
                            for (const cell of this.transcriptCells(view)) {
                                if (cell.outputs.some(output => output.data.kind === 'table')) { await this.render(view, cell.record.id); }
                            }
                        }).catch(error => this.report(error));
                    }
                }
                if (!event.affectsConfiguration('r.interactive.maxAssetBytes')) { return; }
                const limitBytes = util.config().get<number>('interactive.maxAssetBytes', DEFAULT_MAX_ASSET_BYTES);
                for (const view of this.views.values()) {
                    if (view.client.connected && view.client.control && view.client.manifest.capabilities.assetStorage) {
                        void view.client.request('assetStorage', { limitBytes }).catch(error => this.report(error));
                    }
                }
            }));
        setInteractiveExecutor(async (code, resource, source, offerTarget) => {
            const mode = util.config(resource).get<string>('interactive.executionTarget', 'auto');
            if (mode === 'terminal' || (!this.routing && mode !== 'interactive' && !offerTarget)) { return false; }
            try {
                const bound = resource && session.boundSessionForDocument(resource);
                let view = this.routing || mode === 'interactive'
                    ? bound ? [...this.views.values()].find(item => item.target === bound) : this.active : undefined;
                if (view?.restarting) { throw new Error('R is restarting. Wait for the restart notice before running code.'); }
                if (!view || view.disposed || !view.client.connected || ['exited', 'stopping'].includes(view.client.manifest.status)) {
                    // Share one chooser when several Run Selection commands arrive during startup.
                    const pending = this.targetSelection ??= this.chooseExecutionTarget(resource);
                    let chosen: Awaited<typeof pending>;
                    try { chosen = await pending; } finally { if (this.targetSelection === pending) { this.targetSelection = undefined; } }
                    if (!chosen) { return 'cancelled'; }
                    if (chosen === 'createTerminal') { this.routing = false; return chosen; }
                    view = chosen;
                    if (bound && resource) { session.bindSessionDocument(resource, view.target); }
                }
                await this.submit(view, code, source); return 'executed';
            } catch (error) { this.report(error); return 'cancelled'; }
        });
        this.refresh();
        if (util.config().get<boolean>('interactive.restore', true)) {
            void this.restoreConnections();
        }
    }

    private async restoreConnections(): Promise<void> {
        for (const id of this.savedConnections.keys()) {
            if (this.closed) { return; }
            const manifest = this.manifests.find(item => item.id === id);
            if (manifest) {
                try { await this.open(manifest); }
                catch (error) { if (!this.closed) { this.output.appendLine(`Restore ${manifest.label}: ${String(error)}`); } }
            }
        }
        // Restoring background tabs must not leave their workspace selected over
        // the visible Interactive input or a source file with an explicit binding.
        const document = vscode.window.activeTextEditor?.document;
        const target = document && session.boundSessionForDocument(document.uri);
        const focused = [...this.views.values()].find(view => target
            ? view.target === target : view.notebook === vscode.window.activeNotebookEditor?.notebook);
        if (focused) { await this.activate(focused); }
    }

    private saveConnections(): Thenable<void> {
        return this.context.workspaceState.update('r.interactive.connections', [...this.savedConnections.values()]);
    }

    private report(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(message); void vscode.window.showErrorMessage(`R Interactive: ${message}`);
    }

    private async forView(value: unknown, action: (view: InteractiveView) => unknown): Promise<unknown> {
        let view = this.active;
        if (value && typeof value === 'object') {
            const target = value as Partial<SessionManifest> & {
                notebook?: vscode.NotebookDocument; notebookUri?: vscode.Uri; uri?: vscode.Uri;
                notebookEditor?: { notebookUri?: vscode.Uri };
            };
            if (typeof target.id === 'string' && typeof target.generation === 'string') {
                const key = `${target.id}:${target.generation}`;
                if (!this.views.has(key)) { await this.open(target as SessionManifest); }
                view = this.views.get(key);
            } else {
                // Native notebook/Interactive toolbars serialize their editor under notebookEditor.
                const uri = value instanceof vscode.Uri ? value : target.notebookEditor?.notebookUri ?? target.notebook?.uri ?? target.notebookUri ?? target.uri;
                view = uri && [...this.views.values()].find(item => item.notebook.uri.toString() === uri.toString());
            }
            if (!view) { throw new Error('This notebook is not connected to an R Interactive session'); }
        }
        if (!view || view.disposed) { return; }
        return action(view);
    }

    private updateStatus(): void {
        for (const view of this.views.values()) {
            const unavailable = view.restarting ? 'R is restarting. The workspace will refresh when it is ready.'
                : ['exited', 'stopping'].includes(view.client.manifest.status) ? 'R session stopped. Restart it to inspect a new workspace.'
                    : !view.client.connected ? 'R session disconnected. Reconnecting to its workspace…'
                        : view.client.manifest.status === 'starting' ? 'R is starting…' : undefined;
            if (view.target.label !== view.client.manifest.label || view.target.workspaceUnavailable !== unavailable) {
                view.target.label = view.client.manifest.label;
                view.target.workspaceUnavailable = unavailable;
                session.updateSessionWorkspace(view.target, view.target.workspaceData);
            }
            const { label, description, detail } = sessionPresentation(view.client.manifest, view.client.connected, view.client.control,
                view.restarting, view.target.workingDir);
            let changed = false;
            for (const controller of view.controllers) {
                if (controller.label !== label) { controller.label = label; changed = true; }
                if (controller.description !== description) { controller.description = description; changed = true; }
                if (controller.detail !== detail) { controller.detail = detail; changed = true; }
            }
            if (changed && !this.presentationRefresh.has(view)) {
                this.presentationRefresh.add(view);
                // VS Code's native toolbar/picker watches affinity, not kernel property
                // changes. Reassert the existing affinity without changing selection.
                // Property setters send a batched microtask: refresh on the next turn
                // so the workbench receives the new label/details before this event.
                setImmediate(() => {
                    this.presentationRefresh.delete(view);
                    if (!view.disposed && !view.notebook.isClosed) {
                        view.controller.updateNotebookAffinity(view.notebook, vscode.NotebookControllerAffinity.Preferred);
                    }
                });
            }
        }
        const document = vscode.window.activeTextEditor?.document;
        const target = document && session.boundSessionForDocument(document.uri);
        const view = (target && [...this.views.values()].find(item => item.target === target)) || this.active;
        if (!view || view.disposed) { this.status.hide(); return; }
        const manifest = view.client.manifest;
        const queued = [...view.model.cells.values()].filter(cell => cell.record.state === 'queued').length;
        const state = view.restarting ? 'Restarting' : !view.client.connected ? 'Disconnected' : manifest.status === 'input' ? 'Waiting for input' : manifest.status;
        const icon = !view.client.connected ? 'debug-disconnect' : manifest.status === 'busy' ? 'sync~spin' : manifest.status === 'input' ? 'question' : 'terminal';
        this.status.text = `$(${icon}) R: ${manifest.label} · ${state}${queued ? ` · ${queued} queued` : ''}${view.client.connected && !view.client.control ? ' · observing' : ''}`;
        this.status.tooltip = `${sessionPresentation(manifest, view.client.connected, view.client.control,
            view.restarting, view.target.workingDir).tooltip}\nSelect to ${manifest.status === 'input' ? 'reply to R input' : 'switch sessions'}`;
        this.status.command = manifest.status === 'input'
            ? { command: 'r.interactive.input', title: 'Reply to R input', arguments: [manifest] } : 'r.interactive.connect';
        this.status.show();
    }

    private async rename(view: InteractiveView, supplied?: string): Promise<void> {
        if (!view.client.manifest.capabilities.rename) { throw new Error('Renaming requires a session started with the current extension build'); }
        const label = supplied ?? await vscode.window.showInputBox({ title: 'Rename R session', value: view.client.manifest.label,
            validateInput: value => { try { sessionLabel(value); return undefined; } catch (error) { return String(error); } } });
        if (label === undefined) { return; }
        view.client.manifest.label = await view.client.request<string>('rename', { label });
        this.refresh();
    }

    private async sessionActions(view: InteractiveView): Promise<void> {
        const actions = [
            { label: '$(plug) Switch Session…', command: 'r.interactive.connect' },
            { label: '$(add) New Session…', command: 'r.interactive.new' },
            { label: 'Session', kind: vscode.QuickPickItemKind.Separator },
            { label: '$(edit) Rename…', command: 'r.interactive.rename' },
            { label: '$(info) Session Details', command: 'r.interactive.info' },
            { label: 'Execution', kind: vscode.QuickPickItemKind.Separator },
            { label: '$(close-all) Cancel Queued Cells', command: 'r.interactive.cancelQueued' },
            { label: '$(comment) Reply to R Input…', command: 'r.interactive.input' },
            { label: '$(key) Take Control', command: 'r.interactive.takeControl' },
            { label: 'Output', kind: vscode.QuickPickItemKind.Separator },
            { label: '$(graph) Browse Plots…', command: 'r.interactive.plots' },
            { label: '$(export) Export History…', command: 'r.interactive.export' },
            { label: '$(discard) Clean Up Assets', command: 'r.interactive.cleanAssets' },
            { label: 'Lifecycle', kind: vscode.QuickPickItemKind.Separator },
            { label: '$(debug-disconnect) Disconnect', description: 'Keep R running', command: 'r.interactive.detach' },
            { label: '$(debug-stop) Stop Session', description: 'End R and discard its in-memory objects', command: 'r.interactive.stop' },
        ];
        const selected = await vscode.window.showQuickPick(actions, {
            title: `Session: ${view.client.manifest.label}`, placeHolder: 'Choose a session action', matchOnDescription: true,
        });
        // Keep the original notebook as the target even if focus changes while the picker is open.
        if (selected?.command && !view.disposed) { await vscode.commands.executeCommand(selected.command, view.notebook.uri); }
    }

    private async cancelQueued(view: InteractiveView): Promise<void> {
        if (view.client.manifest.capabilities.cancelQueued) { await view.client.request('cancelQueued'); }
        else {
            for (const cell of view.model.cells.values()) {
                if (cell.record.state === 'queued') { await view.client.request('cancel', { id: cell.record.id }); }
            }
        }
    }

    private async clearCompleted(view: InteractiveView): Promise<void> {
        view.chain = view.chain.then(async () => {
            if (view.disposed) { return; }
            const edits: vscode.NotebookEdit[] = [];
            for (const cell of view.notebook.getCells().slice().reverse()) {
                const id = cell.metadata.rExecutionId as string | undefined;
                const record = id && this.transcriptCells(view).find(cell => cell.record.id === id)?.record;
                if (record && !['queued', 'running', 'unknown'].includes(record.state)) {
                    view.hidden.add(record.id);
                    const adjacent = edits.at(-1);
                    if (adjacent?.range.start === cell.index + 1) {
                        edits[edits.length - 1] = vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cell.index, adjacent.range.end));
                    } else { edits.push(vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cell.index, cell.index + 1))); }
                }
            }
            const edit = new vscode.WorkspaceEdit(); edit.set(view.notebook.uri, edits);
            await vscode.workspace.applyEdit(edit);
        });
        await view.chain;
    }

    private async insertCode(view: InteractiveView, code: string): Promise<void> {
        if (view.inputUri) {
            await vscode.commands.executeCommand('interactive.open', { preserveFocus: false }, view.notebook.uri);
        } else {
            await vscode.window.showNotebookDocument(view.notebook, { preserveFocus: false });
        }
        const edit = new vscode.WorkspaceEdit();
        if (view.inputUri) {
            const document = await vscode.workspace.openTextDocument(view.inputUri);
            const current = document.getText();
            edit.insert(document.uri, document.positionAt(current.length), `${current && !current.endsWith('\n') ? '\n' : ''}${code}`);
        } else {
            edit.set(view.notebook.uri, [vscode.NotebookEdit.insertCells(view.notebook.cellCount,
                [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, 'r')])]);
        }
        await vscode.workspace.applyEdit(edit);
        if (view.inputUri) { await vscode.commands.executeCommand('interactive.input.focus'); }
    }

    private async source(source?: SourceLocation): Promise<void> {
        if (!source) { void vscode.window.showInformationMessage('This code was entered directly in the Interactive window.'); return; }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(source.uri));
        const line = Math.min(source.line, document.lineCount - 1);
        await vscode.window.showTextDocument(document, { selection: new vscode.Range(line, 0, line, 0) });
    }

    private history(view: InteractiveView): void {
        type Item = vscode.QuickPickItem & { record: ExecutionRecord };
        const picker = vscode.window.createQuickPick<Item>();
        const older = { iconPath: new vscode.ThemeIcon('history'), tooltip: 'Load older matching commands' };
        const copy = { iconPath: new vscode.ThemeIcon('copy'), tooltip: 'Copy code' };
        const run = { iconPath: new vscode.ThemeIcon('play'), tooltip: 'Run again in this session' };
        const source = { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: 'Go to source' };
        picker.title = `R history: ${view.client.manifest.label}`;
        picker.placeholder = 'Search code; Enter inserts it into the input for editing';
        picker.matchOnDescription = true; picker.matchOnDetail = true;
        let version = 0, closed = false, timer: NodeJS.Timeout | undefined;
        const load = async (more = false, request = ++version): Promise<void> => {
            picker.busy = true;
            try {
                const before = more ? picker.items.at(-1)?.record.order : undefined;
                // Orders restart at one for each R process. Use a transcript-wide order for
                // history pagination after restart, including admission records outside replay.
                const records = (): ExecutionRecord[] => view.history.length
                    ? [...view.history, view.model].flatMap(model => readExecutionRecords(path.join(this.root, view.client.manifest.id, model.generation)))
                        .map((record, index) => ({ ...record, order: index + 1 }))
                    : this.transcriptCells(view).map(cell => cell.record);
                const page = !view.history.length && view.client.connected && view.client.manifest.capabilities.history
                    ? await view.client.request<HistoryPage>('history', { query: picker.value, before })
                    : searchHistory(records(), picker.value, before);
                if (closed || request !== version) { return; }
                const items = page.executions.map(record => ({ record, alwaysShow: true,
                    label: `#${record.order} ${record.code.split('\n')[0].slice(0, 100)}`,
                    description: `${record.state} · ${new Date(record.accepted).toLocaleString()}`,
                    detail: record.code.slice(0, 600), buttons: record.source ? [copy, run, source] : [copy, run] }));
                picker.items = more ? [...picker.items, ...items] : items;
                picker.buttons = page.more ? [older] : [];
            } catch (error) {
                if (!closed && request === version) { picker.placeholder = String(error); }
            } finally { if (!closed && request === version) { picker.busy = false; } }
        };
        const listeners: vscode.Disposable[] = [
            picker.onDidChangeValue(() => { clearTimeout(timer); const request = ++version; timer = setTimeout(() => { void load(false, request); }, 150); }),
            picker.onDidTriggerButton(() => { void load(true); }),
            picker.onDidAccept(() => { const item = picker.selectedItems[0]; if (item) { picker.hide(); void this.insertCode(view, item.record.code).catch(error => this.report(error)); } }),
            picker.onDidTriggerItemButton(event => {
                const record = event.item.record;
                if (event.button === copy) { void vscode.env.clipboard.writeText(record.code); }
                else { picker.hide(); void (event.button === run ? this.submit(view, record.code, record.source) : this.source(record.source)).catch(error => this.report(error)); }
            }),
            picker.onDidHide(() => { closed = true; clearTimeout(timer); listeners.forEach(listener => { listener.dispose(); }); picker.dispose(); }),
        ];
        picker.show(); void load();
    }

    private async plots(view: InteractiveView): Promise<void> {
        const items = this.transcriptCells(view).reverse().flatMap(cell => cell.outputs.filter(output =>
            output.type === 'display' && ['plot', 'image'].includes(String(output.data.kind))).map((output, index) => ({
            label: `#${cell.record.order} · Plot ${index + 1}`, description: cell.record.code.split('\n')[0].slice(0, 120),
            detail: new Date(cell.record.accepted).toLocaleString(), data: output.data,
        })));
        if (!items.length) { void vscode.window.showInformationMessage('This session has no plots in its restored history.'); return; }
        const selected = await vscode.window.showQuickPick(items, { title: `Plots: ${view.client.manifest.label}`, matchOnDescription: true });
        if (selected) { await this.openOutput(view, selected.data); }
    }

    private async openOutput(view: InteractiveView, data: Record<string, unknown>): Promise<void> {
        let url = data.svg || data.asset ? view.base + String(data.svg ?? data.asset).split('/').map(encodeURIComponent).join('/') : String(data.url ?? '');
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url)) { url = (await vscode.env.asExternalUri(vscode.Uri.parse(url))).toString(true); }
        if (data.kind === 'image' && !url) { url = `data:${String(data.mime)};base64,${String(data.data)}`; }
        const html = data.kind === 'mime' && data.mime === 'text/html';
        if (!url && !html) { return; }
        const kind = ['plot', 'image'].includes(String(data.kind)) ? 'Plot' : 'Viewer';
        const panel = vscode.window.createWebviewPanel('rInteractiveOutput', `${kind}: ${view.client.manifest.label}`, vscode.ViewColumn.Beside, { enableScripts: true });
        panel.webview.html = `<!doctype html><html><body style="margin:0">${['plot', 'image'].includes(String(data.kind))
            ? `<img alt="R plot" src="${escapeXml(url)}" style="display:block;max-width:100%;height:auto;margin:auto">`
            : `<iframe sandbox="allow-scripts allow-forms allow-downloads" ${html ? `srcdoc="${escapeXml(String(data.text))}"` : `src="${escapeXml(url)}"`} style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>`}</body></html>`;
    }

    private defaultExportUri(view: InteractiveView, suffix: string): vscode.Uri {
        // eslint-disable-next-line no-control-regex -- export names must exclude control characters
        const name = view.client.manifest.label.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '') || 'R';
        return vscode.Uri.file(path.join(view.target.workingDir, `${name}-${suffix}`));
    }

    refresh(): void {
        try { this.manifests = discoverSessions(this.root).filter(hasSessionEndpoint); }
        catch (error) { this.manifests = []; this.report(error); }
        const manifests = new Map(this.manifests.map(manifest => [`${manifest.id}:${manifest.generation}`, manifest]));
        for (const view of this.views.values()) {
            const manifest = view.client.manifest;
            manifests.set(`${manifest.id}:${manifest.generation}`, manifest);
        }
        this.manifests = [...manifests.values()];
        this.changes.fire(undefined);
        this.updateStatus();
    }
    getChildren(): SessionManifest[] { return this.manifests; }
    getTreeItem(manifest: SessionManifest): vscode.TreeItem {
        const view = this.views.get(`${manifest.id}:${manifest.generation}`);
        manifest = view?.client.manifest ?? manifest;
        const presentation = sessionPresentation(manifest, view?.client.connected, view?.client.control ?? false,
            view?.restarting, view?.target.workingDir);
        const item = new vscode.TreeItem(manifest.label);
        item.id = `${manifest.id}:${manifest.generation}`; item.description = `${presentation.state} · ${manifest.provider}`;
        const age = sessionAge(manifest);
        if (age) { item.description += ` · ${age}`; }
        item.contextValue = 'rInteractiveSession';
        if (view?.client.connected && !view.client.control) { item.description += ' · observing'; }
        item.tooltip = presentation.tooltip;
        item.iconPath = new vscode.ThemeIcon(manifest.status === 'busy' ? 'sync~spin' : manifest.status === 'exited' ? 'circle-outline' : 'terminal');
        item.command = { command: 'r.interactive.open', title: 'Open R Interactive', arguments: [manifest] };
        return item;
    }

    private async create(adopt?: ArfSession, resource = vscode.window.activeTextEditor?.document.uri): Promise<InteractiveView | undefined> {
        if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before starting or controlling R'); }
        const directory = adopt?.cwd ?? vscode.workspace.getWorkspaceFolder(resource ?? vscode.Uri.file(this.root))?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? process.cwd();
        const rPath = await util.getRpath(false, resource);
        if (!rPath) { throw new Error('Configure an R executable before starting Interactive'); }
        const arfCommand = this.arfCommand(resource);
        let arfPath = adopt ? undefined : resolveArfExecutable(arfCommand, directory);
        const provider = adopt ? 'arf-existing' : await vscode.window.showQuickPick([
            { label: 'R', detail: rPath, value: 'r' as const },
            ...(arfPath ? [{ label: 'arf', detail: arfPath, value: 'arf' as const }]
                : [{ label: '$(gear) Configure arf…', description: 'Optional · executable unavailable',
                    detail: `Use R, or install arf on this host and set its path. Checked: ${arfCommand}`, value: 'configure' as const }]),
        ], { title: 'R Interactive session provider' });
        if (!provider) { return; }
        const kind = typeof provider === 'string' ? provider : provider.value;
        if (kind === 'configure') { await this.configureArf(); return; }
        const label = await vscode.window.showInputBox({ title: 'Session name', value: adopt ? `arf ${adopt.pid}` : path.basename(directory) });
        if (!label) { return; }
        if (kind === 'arf' && !(arfPath = this.checkArfExecutable(arfPath ?? arfCommand, directory))) { return; }
        const supervision = util.config(resource).get<string>('interactive.supervision', 'auto');
        prepareSupervisor(supervision, directory);
        const node = await this.nodeRuntime(directory, resource);
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting persistent R Interactive' }, async progress => {
            progress.report({ message: 'Preparing the private R runtime' });
            const runtime = await installRuntime(this.context.extensionPath, this.root, rPath, text => this.output.append(text));
            if (kind === 'arf' && !(arfPath = this.checkArfExecutable(arfPath ?? arfCommand, directory))) { return; }
            const identity = newIdentity();
            const config: AgentConfig = { ...identity, label, directory, storage: path.join(this.root, identity.id),
                rPath, library: runtime.library, resources: runtime.resources, provider: kind,
                arfPath, arfEndpoint: adopt?.socket_path,
                supervision,
                plotBackend: util.config().get<AgentConfig['plotBackend']>('interactive.plotBackend', 'auto'),
                historyLimit: util.config().get<number>('interactive.historyLimit', 100),
                maxOutputBytes: util.config().get<number>('interactive.maxOutputBytes', 4 * 1024 * 1024),
                maxAssetBytes: util.config().get<number>('interactive.maxAssetBytes', DEFAULT_MAX_ASSET_BYTES),
                maxJournalBytes: util.config().get<number>('interactive.maxJournalBytes', 128 * 1024 * 1024) };
            progress.report({ message: 'Launching the independent session agent' });
            const manifest = await launchAgent(config, runtime.agent, node, text => this.output.appendLine(text));
            this.refresh(); await this.open(manifest);
            return this.views.get(`${manifest.id}:${manifest.generation}`);
        });
    }

    private arfCommand(resource?: vscode.Uri): string {
        return util.substituteVariables(util.config(resource).get<string>('interactive.arfPath', 'arf'), resource).trim() || 'arf';
    }

    private nodeRuntime(directory: string, resource?: vscode.Uri): Promise<string> {
        return prepareNodeRuntime(util.substituteVariables(util.config(resource).get<string>('interactive.nodePath', 'node'), resource), directory);
    }

    private async configureArf(): Promise<void> {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'r.interactive.arfPath');
    }

    private checkArfExecutable(command: string, directory: string, restarting = false): string | undefined {
        const executable = resolveArfExecutable(command, directory);
        if (executable) { return executable; }
        // A nonmodal setup notification must not keep the view in Restarting or
        // hold the source execution target chooser until the user dismisses it.
        void Promise.resolve(vscode.window.showWarningMessage(
            `Cannot ${restarting ? 'restart' : 'start'} Headless arf: “${command}” was not found or is not executable on this host. ` +
            'Install arf or set r.interactive.arfPath to its executable. Plain R sessions do not require arf.' +
            (restarting ? ' The current R session has not been stopped.' : ''), 'Configure arf')).then(async action => {
            if (action === 'Configure arf') { await this.configureArf(); }
        }).catch(error => this.report(error));
    }

    private async sessionChoices(): Promise<SessionChoice[]> {
        this.refresh();
        const live = await runningSessions(this.manifests.filter(hasSessionEndpoint));
        const terminals: ArfSession[] = [];
        const arfCandidates = discoverArf().filter(arf => fs.existsSync(arf.socket_path) && !live.some(item => item.rPid === arf.pid));
        for (let i = 0; i < arfCandidates.length; i += 8) {
            const batch = await Promise.all(arfCandidates.slice(i, i + 8).map(arf => probeArfSession(arf)));
            for (const arf of batch) { if (arf) { terminals.push(arf); } }
        }
        return [
            ...live.map(manifest => ({ label: manifest.label,
                description: this.sessionChoiceDescription(manifest),
                detail: `${manifest.directory} · ${manifest.id.slice(0, 8)}`, manifest })),
            ...terminals.map(arf =>
                ({ label: `arf ${arf.pid}`, description: `${arf.r_version ?? ''} · ${arf.cwd ?? ''}`, arf })),
            { label: '$(add) New persistent R session', create: true },
        ];
    }

    private async chooseExecutionTarget(resource?: vscode.Uri): Promise<InteractiveView | 'createTerminal' | undefined> {
        const choices = this.sessionChoices().then(items => [
            { label: '$(add) New R Interactive window', description: 'Start a persistent R session', create: true },
            ...(util.config(resource).get<string>('interactive.executionTarget') === 'interactive' ? []
                : [{ label: '$(terminal) Create R terminal', description: 'Run R in the Terminal pane', terminal: true }]),
            ...items.filter(item => !item.create),
        ] as SessionChoice[]);
        const selected = await vscode.window.showQuickPick(choices, { title: 'Run R code',
            placeHolder: 'Choose where to run the selected code', matchOnDescription: true, matchOnDetail: true });
        if (selected?.terminal) { return 'createTerminal'; }
        if (selected?.create || selected?.arf) { return this.create(selected.arf, resource); }
        if (selected?.manifest) {
            await this.open(selected.manifest);
            return this.views.get(`${selected.manifest.id}:${selected.manifest.generation}`);
        }
    }

    private sessionChoiceDescription(manifest: SessionManifest): string {
        const age = sessionAge(manifest);
        return `${manifest.status} · ${manifest.provider} · PID ${manifest.rPid ?? 'starting'}${age ? ` · ${age}` : ''}`;
    }

    private async pick(): Promise<void> {
        // Passing a promise keeps the picker responsive while local agents are checked.
        const selected = await vscode.window.showQuickPick(this.sessionChoices(), { title: 'Connect to a persistent R session',
            placeHolder: 'Select a running session or create a new one', matchOnDescription: true, matchOnDetail: true });
        if (selected?.manifest) { await this.open(selected.manifest); }
        else if (selected?.arf) { await this.create(selected.arf); }
        else if (selected?.create) { await this.create(); }
    }

    async open(manifest: SessionManifest): Promise<void> {
        const key = `${manifest.id}:${manifest.generation}`;
        const pending = this.opening.get(key);
        if (pending) { return pending; }
        const opening = this.openView(manifest);
        this.opening.set(key, opening);
        try { await opening; } finally { this.opening.delete(key); }
    }

    private async openView(manifest: SessionManifest): Promise<void> {
        if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before connecting to R'); }
        const key = `${manifest.id}:${manifest.generation}`;
        const previous = this.views.get(key);
        if (previous && !previous.notebook.isClosed && (previous.client.connected || previous.restarting)) {
            if (previous.notebook.notebookType === 'interactive') {
                await vscode.commands.executeCommand('interactive.open', { preserveFocus: true }, previous.notebook.uri);
            } else {
                const editor = vscode.window.visibleNotebookEditors.find(item => item.notebook === previous.notebook);
                await vscode.window.showNotebookDocument(previous.notebook, { preserveFocus: true, viewColumn: editor?.viewColumn });
            }
            await this.activate(previous); return;
        }
        if (previous) { this.disposeView(previous, false); }
        const client = new AgentClient(manifest, this.clientId);
        const created: vscode.Disposable[] = [ { dispose: () => client.close() } ];
        try {
            try { await client.connect(); }
            catch (error) {
                if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                    this.refresh();
                    throw new Error(`Session “${manifest.label}” is no longer available. Refresh the session list or start a new session. Its saved history has not been removed.`, { cause: error });
                }
                throw error;
            }
            if (this.closed) { throw new Error('Interactive manager was closed during connection'); }
            const makeController = (type: string): vscode.NotebookController => {
                const controller = vscode.notebooks.createNotebookController(`r-${manifest.id}-${manifest.generation}-${type}`, type, `R: ${manifest.label}`);
                controller.supportedLanguages = ['r']; controller.supportsExecutionOrder = true;
                controller.executeHandler = cells => {
                    if (cells.some(cell => cell.notebook !== view.notebook)) {
                        this.report(new Error('This kernel belongs to another Interactive window. Connect this notebook to its original session before running it.'));
                        return;
                    }
                    return this.executeCells(view, cells);
                };
                controller.interruptHandler = () => view.client.request<void>('interrupt');
                created.push(controller);
                return controller;
            };
            const native = makeController('interactive');
            const fallback = makeController('r-interactive');
            let notebook: vscode.NotebookDocument;
            let inputUri: vscode.Uri | undefined;
            let notebookEditor: vscode.NotebookEditor | undefined;
            let controller = native;
            const savedUri = this.savedConnections.get(manifest.id)?.notebookUri;
            const existing = vscode.workspace.notebookDocuments.find(document =>
                document.metadata.rSessionId === manifest.id ||
                (!document.metadata.rSessionId && document.uri.toString() === savedUri));
            try {
                if (existing?.notebookType === 'r-interactive') { throw new Error('Restoring an R Interactive notebook'); }
                const result = await vscode.commands.executeCommand<{ notebookUri: vscode.Uri; inputUri: vscode.Uri; notebookEditor?: vscode.NotebookEditor }>(
                    'interactive.open', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                    existing?.uri ?? (savedUri ? vscode.Uri.parse(savedUri) : undefined),
                    `${this.context.extension.id}/${native.id}`, `R: ${manifest.label}`);
                if (!result?.notebookUri || !result.inputUri) { throw new Error('Interactive Window returned no document'); }
                notebook = await vscode.workspace.openNotebookDocument(result.notebookUri); inputUri = result.inputUri;
                notebookEditor = result.notebookEditor;
            } catch (error) {
                this.output.appendLine(`Using notebook fallback: ${String(error)}`);
                controller = fallback;
                notebook = existing?.notebookType === 'r-interactive' ? existing : await vscode.workspace.openNotebookDocument('r-interactive', new vscode.NotebookData([]));
                fallback.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
                notebookEditor = await vscode.window.showNotebookDocument(notebook, { preserveFocus: true });
            }
            if (this.closed) { throw new Error('Interactive manager was closed during connection'); }
            const target = this.registerTarget(client);
            session.bindSessionDocument(vscode.Uri.from({ scheme: 'vscode-notebook-cell', path: notebook.uri.path }), target);
            const view: InteractiveView = { client, target, model: new Transcript(manifest.generation), history: this.readHistory(manifest), notebook, controller,
                controllers: [native, fallback], inputUri, executions: new Map(), chain: Promise.resolve(),
                pending: new Set(), disposed: false, prompts: new Set(), base: '', hidden: new Set() };
            this.views.set(key, view);
            controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
            // A restored native tab may still have the previous generation's kernel selected.
            if (notebookEditor) {
                await vscode.commands.executeCommand('notebook.selectKernel', {
                    id: controller.id, extension: this.context.extension.id, notebookEditor,
                });
            }
            if (inputUri) {
                session.bindSessionDocument(inputUri, target);
                await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(inputUri), 'r');
            }
            await this.restore(view, await client.snapshot());
            if (this.closed || view.disposed) { throw new Error('Interactive manager was closed during connection'); }
            this.listen(view, client);
            if (!await client.subscribe(view.model.seq)) { await this.restore(view, await client.snapshot()); await client.subscribe(view.model.seq); }
            await this.activate(view);
            this.savedConnections.set(manifest.id, { id: manifest.id, notebookUri: notebook.uri.toString() });
            await this.saveConnections();
        } catch (error) {
            const view = this.views.get(key);
            if (view) { this.disposeView(view, false); }
            else { created.forEach(item => { item.dispose(); }); }
            throw error;
        }
    }

    private registerTarget(client: AgentClient): session.Session {
        const manifest = client.manifest;
        const target = session.registerSessionTransport(`${manifest.id}:${manifest.generation}`, manifest.host, manifest.directory, data =>
            client.request('inspect', { method: data.method, params: data.params ?? {} }, data.method === 'hover' || data.method === 'completion' ? 250 : 6000));
        target.pid = String(manifest.rPid ?? ''); target.rVer = manifest.rVersion ?? '';
        target.rPath = manifest.rPath; target.libraryPaths = manifest.libraryPaths;
        target.label = manifest.label;
        target.execute = async code => {
            const view = [...this.views.values()].find(item => item.target === target);
            if (!view || view.disposed) { throw new Error('This Interactive session is no longer attached.'); }
            await this.submit(view, code);
        };
        return target;
    }

    private listen(view: InteractiveView, client: AgentClient): void {
        client.on('event', (event: SessionEvent) => {
            if (view.client !== client) { return; }
            view.chain = view.chain.then(() => this.event(view, event)).catch(error => this.report(error));
        });
        client.on('activity', () => { if (view.client === client) { this.updateStatus(); this.changes.fire(undefined); } });
        client.on('disconnect', () => {
            if (view.client !== client || view.restarting) { return; }
            this.updateStatus(); this.changes.fire(undefined); this.reconnect(view, 1000);
        });
    }

    private readHistory(manifest: SessionManifest): Transcript[] {
        const storage = path.join(this.root, manifest.id);
        const file = path.join(storage, 'config.json');
        if (!fs.existsSync(file)) { return []; }
        const config = JSON.parse(fs.readFileSync(file, 'utf8')) as AgentConfig;
        return (config.previousGenerations ?? []).filter(generation => generation !== manifest.generation).map(generation => {
            const model = new Transcript(generation);
            model.restore({ manifest: { ...manifest, generation }, ...readPreviousJournal(storage, generation, config.historyLimit) });
            return model;
        });
    }

    private transcriptCells(view: InteractiveView): TranscriptCell[] {
        return [...view.history, view.model].flatMap(model => [...model.cells.values()]);
    }

    private async restore(view: InteractiveView, snapshot: AgentSnapshot): Promise<void> {
        const drafts = view.notebook.getCells().filter(cell => cell.kind === vscode.NotebookCellKind.Code && !cell.metadata.rExecutionId)
            .map(cell => new vscode.NotebookCellData(cell.kind, cell.document.getText(), cell.document.languageId));
        const edited = new Map(view.notebook.getCells().map(cell => [cell.metadata.rExecutionId as string, cell.document.getText()]));
        const previousNotice = view.notebook.getCells().find(cell => cell.metadata.rSessionNotice === snapshot.manifest.generation);
        for (const { task } of view.executions.values()) { task.end(undefined); }
        view.executions.clear();
        for (const cell of view.notebook.getCells()) { session.unbindSessionDocument(cell.document.uri); }
        view.client.manifest = snapshot.manifest;
        view.target.rPath = snapshot.manifest.rPath; view.target.libraryPaths = snapshot.manifest.libraryPaths;
        view.base = snapshot.manifest.assetBase ? (await vscode.env.asExternalUri(vscode.Uri.parse(snapshot.manifest.assetBase))).toString(true) : '';
        view.model.restore(snapshot);
        if (snapshot.workspace) { view.target.workspaceData = snapshot.workspace as unknown as session.WorkspaceData; }
        const cells: vscode.NotebookCellData[] = [];
        for (const model of [...view.history, view.model]) {
            for (const cell of model.cells.values()) {
                if (!view.hidden.has(cell.record.id)) {
                    const data = await this.cellData(view, cell);
                    data.value = edited.get(cell.record.id) ?? data.value;
                    cells.push(data);
                }
            }
            if (model !== view.model) { cells.push(this.noticeData(view, 'restarted', model.generation)); }
        }
        if (snapshot.manifest.status === 'exited') { cells.push(this.noticeData(view, 'stopped')); }
        else if (previousNotice) {
            const notice = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, previousNotice.document.getText(), 'markdown');
            notice.metadata = previousNotice.metadata; cells.push(notice);
        }
        cells.push(...drafts);
        if (view.notebook.notebookType === 'r-interactive' && !drafts.length) { cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'r')); }
        const edit = new vscode.WorkspaceEdit();
        edit.set(view.notebook.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(0, view.notebook.cellCount), cells),
            vscode.NotebookEdit.updateNotebookMetadata({ rSessionId: snapshot.manifest.id, rGeneration: snapshot.manifest.generation })]);
        await vscode.workspace.applyEdit(edit);
        for (const cell of view.notebook.getCells()) { session.bindSessionDocument(cell.document.uri, view.target); }
        if (snapshot.input && view.client.control) { void this.prompt(view, snapshot.input); }
    }

    private async activate(view: InteractiveView): Promise<void> {
        if (view.disposed) { return; }
        this.active = view; this.routing = true;
        ensureWorkspaceViewer();
        this.updateStatus();
        // Select synchronously before any command round trips; the latest focus wins.
        const activated = session.activateSession(view.target);
        await vscode.commands.executeCommand('setContext', 'r.WorkspaceViewer:show', true);
        await activated;
        await vscode.commands.executeCommand('setContext', 'r.interactive.active', true);
        await vscode.commands.executeCommand('setContext', 'r.interactive.notebook', vscode.window.activeNotebookEditor?.notebook === view.notebook);
        this.updateStatus();
    }

    private cell(view: InteractiveView, id: string): vscode.NotebookCell | undefined {
        return view.notebook.getCells().find(cell => cell.metadata.rExecutionId === id);
    }

    private async submit(view: InteractiveView, code: string, source?: SourceLocation): Promise<void> {
        if (!code.trim()) { return; }
        if (view.restarting) { throw new Error('R is restarting. Wait for the restart notice before running code.'); }
        if (!view.client.control) { throw new Error('This window is observing R. Run R: Take Control of Interactive Session first.'); }
        const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, 'r');
        const id = randomUUID(); data.metadata = { rExecutionId: id, rSource: source };
        const edit = new vscode.WorkspaceEdit();
        edit.set(view.notebook.uri, [vscode.NotebookEdit.insertCells(view.notebook.cellCount, [data])]);
        await vscode.workspace.applyEdit(edit);
        const cell = this.cell(view, id);
        if (cell) { await this.executeCells(view, [cell]); }
    }

    private async executeCells(view: InteractiveView, cells: readonly vscode.NotebookCell[]): Promise<void> {
        if (!view || view.disposed) { return; }
        if (view.restarting) { throw new Error('R is restarting. Wait for the restart notice before running code.'); }
        if (['exited', 'stopping'].includes(view.client.manifest.status)) { throw new Error('This R session has stopped. Restart it or choose another session to run code.'); }
        if (!view.client.control) { throw new Error('Take control of this session before executing'); }
        for (const cell of cells) {
            const code = cell.document.getText(); if (!code.trim()) { continue; }
            // Re-running creates a new execution identity, even if the same cell is selected.
            const previousId = cell.metadata.rExecutionId as string | undefined;
            if (previousId && this.transcriptCells(view).some(cell => cell.record.id === previousId)) {
                await this.submit(view, code, cell.metadata.rSource as SourceLocation | undefined);
                continue;
            }
            const id = previousId && !view.model.cells.has(previousId) ? previousId : randomUUID();
            const source = cell.metadata.rSource as SourceLocation | undefined;
            const edit = new vscode.WorkspaceEdit();
            edit.set(view.notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cell.index, { ...cell.metadata, rExecutionId: id })]);
            await vscode.workspace.applyEdit(edit);
            session.bindSessionDocument(cell.document.uri, view.target);
            const task = view.controller.createNotebookCellExecution(cell);
            view.executions.set(id, { task, started: false });
            try { await view.client.request('submit', { submission: { id, code, source } }); }
            catch (error) {
                // Query by the same ID; never resubmit code after an ambiguous transport failure.
                this.output.appendLine(`Submission ${id}: ${String(error)}`);
                if (view.executions.get(id)?.task === task) { task.end(undefined); view.executions.delete(id); }
                throw error;
            }
        }
    }

    private async event(view: InteractiveView, event: SessionEvent): Promise<void> {
        if (view.disposed || event.generation !== view.model.generation || event.seq <= view.model.seq) { return; }
        const changed = view.model.apply(event);
        this.updateStatus();
        if (event.type === 'state') {
            view.client.manifest.status = event.data.status as SessionManifest['status'];
            view.client.manifest.rPid = typeof event.data.rPid === 'number' ? event.data.rPid : undefined;
            view.client.manifest.rVersion = typeof event.data.rVersion === 'string' ? event.data.rVersion : undefined;
            view.client.manifest.ended = typeof event.data.ended === 'number' ? event.data.ended : undefined;
            view.target.pid = String(event.data.rPid ?? ''); view.target.rVer = String(event.data.rVersion ?? '');
            this.refresh();
            if (event.data.status === 'exited' && !view.restarting) {
                await this.sessionNotice(view, 'stopped');
                for (const cell of this.transcriptCells(view)) {
                    if (cell.outputs.some(output => output.type === 'display')) { await this.render(view, cell.record.id); }
                }
            }
        } else if (event.type === 'session' && typeof event.data.label === 'string') {
            view.client.manifest.label = event.data.label;
            this.refresh();
        } else if (event.type === 'workspace') {
            session.updateSessionWorkspace(view.target, event.data as unknown as session.WorkspaceData);
        } else if (event.type === 'input' && view.client.control) {
            void this.prompt(view, event.data);
        } else if (event.type === 'clientRequest' && view.client.control) {
            void this.clientRequest(view, event.data);
        } else if (event.type === 'notification') {
            const params = object(event.data.params ?? {});
            if (event.data.method === 'help') { await session.showHelpNotification(params); }
            if (event.data.method === 'rstudioapi/send_to_console') {
                if (params.execute) { await this.submit(view, String(params.code)); }
                else if (view.inputUri) {
                    const document = await vscode.workspace.openTextDocument(view.inputUri);
                    const edit = new vscode.WorkspaceEdit(); edit.insert(document.uri, document.positionAt(document.getText().length), String(params.code));
                    await vscode.workspace.applyEdit(edit);
                }
            }
        } else if (event.type === 'agentError' || event.type === 'agentWarning') {
            this.output.appendLine(String(event.data.message));
        }
        if (!changed || view.hidden.has(changed)) { return; }
        if (!this.cell(view, changed)) {
            const data = await this.cellData(view, view.model.cells.get(changed)!);
            const edit = new vscode.WorkspaceEdit(); edit.set(view.notebook.uri, [vscode.NotebookEdit.insertCells(view.notebook.cellCount, [data])]);
            await vscode.workspace.applyEdit(edit);
        }
        if (event.type === 'started') {
            let execution = view.executions.get(changed);
            if (!execution) {
                try {
                    execution = { task: view.controller.createNotebookCellExecution(this.cell(view, changed)!), started: false };
                    view.executions.set(changed, execution);
                }
                catch { /* Restored/observed execution can still display its retained state. */ }
            }
            if (execution) {
                execution.task.executionOrder = Number(event.data.order);
                if (!execution.started) { execution.task.start(event.time); execution.started = true; }
            }
        }
        if (event.type === 'finished' || event.type === 'uncertain') {
            view.pending.delete(changed);
            try { await this.render(view, changed); }
            finally {
                const execution = view.executions.get(changed);
                if (execution) {
                    execution.task.end(event.data.state === 'success' ? true : event.data.state === 'error' ? false : undefined, event.time);
                    view.executions.delete(changed);
                }
            }
        } else {
            view.pending.add(changed);
            if (!view.timer) {
                view.timer = setTimeout(() => {
                    view.timer = undefined;
                    const ids = [...view.pending]; view.pending.clear();
                    view.chain = view.chain.then(async () => { for (const id of ids) { await this.render(view, id); } }).catch(error => this.report(error));
                }, 40);
            }
        }
    }

    private async cellData(view: InteractiveView, cell: TranscriptCell, portable = false): Promise<vscode.NotebookCellData> {
        const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, cell.record.code, 'r');
        data.metadata = { rExecutionId: cell.record.id, rGeneration: cell.generation, rSource: cell.record.source, rState: cell.record.state };
        data.executionSummary = { executionOrder: cell.record.order,
            success: cell.record.state === 'success' ? true : cell.record.state === 'error' ? false : undefined,
            timing: cell.record.started && cell.record.ended ? { startTime: cell.record.started, endTime: cell.record.ended } : undefined };
        data.outputs = await this.outputs(view, cell, portable);
        return data;
    }

    private async outputs(view: InteractiveView, cell: TranscriptCell, portable = false): Promise<vscode.NotebookCellOutput[]> {
        const outputs: vscode.NotebookCellOutput[] = [];
        const plots: { output: vscode.NotebookCellOutput; data: Record<string, unknown> }[] = [];
        for (const output of cell.outputs) {
            const data = output.data;
            let items: vscode.NotebookCellOutputItem[];
            if (output.type === 'stream') {
                items = [data.channel === 'stderr' ? vscode.NotebookCellOutputItem.stderr(String(data.text)) : vscode.NotebookCellOutputItem.stdout(String(data.text))];
            } else if (output.type === 'condition') {
                if (data.kind === 'error') {
                    const message = String(data.message);
                    // VS Code renders a nonempty stack in place of the message.
                    // Include the heading so nested calls cannot hide the cause.
                    const trace = Array.isArray(data.trace) ? data.trace.join('\n') : '';
                    const stack = `R error: ${message}${trace ? `\n${trace}` : ''}`;
                    items = [vscode.NotebookCellOutputItem.error({ name: 'R error', message, stack })];
                } else {
                    items = [vscode.NotebookCellOutputItem.stderr(`${String(data.kind)}: ${String(data.message)}\n`)];
                }
            } else if (output.type === 'truncated') { items = [vscode.NotebookCellOutputItem.text(String(data.message))]; }
            else if (data.kind === 'mime' && data.mime !== 'text/html') {
                items = [vscode.NotebookCellOutputItem.text(String(data.text), String(data.mime))];
            } else {
                const display: Record<string, unknown> = { ...data, generation: cell.generation,
                    archived: cell.generation !== view.model.generation, connected: view.client.connected,
                    running: !['exited', 'stopping'].includes(view.client.manifest.status) };
                const preference = this.outputViews.get(`${view.client.manifest.id}:${cell.generation}:${String(data.displayId)}`);
                if (data.kind === 'table') { display.tableView = preference?.tableView ?? util.config().get('interactive.tableView', 'table'); }
                if (data.svg || data.asset) { display.url = view.base + String(data.svg ?? data.asset).split('/').map(encodeURIComponent).join('/'); }
                else if (typeof data.url === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(data.url)) {
                    display.url = (await vscode.env.asExternalUri(vscode.Uri.parse(data.url))).toString(true);
                }
                if (data.kind === 'mime' && data.mime === 'text/html') { display.kind = 'htmlText'; }
                items = [vscode.NotebookCellOutputItem.json(display, DISPLAY_MIME),
                    vscode.NotebookCellOutputItem.text(data.kind === 'table' ? String(data.printedText ?? `${String(data.totalRows)} rows\n${JSON.stringify(data.rows, null, 2)}`) : `R ${String(data.kind)} output`)];
                if (typeof data.svg === 'string') {
                    try {
                        const svg = portable ? readAsset(path.join(this.root, view.client.manifest.id, 'assets'), data.svg).toString('base64')
                            : await view.client.request<string>('asset', { id: data.svg });
                        display.svgData = svg;
                        items[0] = vscode.NotebookCellOutputItem.json(display, DISPLAY_MIME);
                        items.push(new vscode.NotebookCellOutputItem(Buffer.from(svg, 'base64'), 'image/svg+xml'));
                    }
                    catch (error) {
                        if (portable) { throw error; }
                        // The live renderer can load a larger SVG directly from its asset URL.
                    }
                }
                if (data.kind === 'image') {
                    const bytes = typeof data.asset === 'string'
                        ? readAsset(path.join(this.root, view.client.manifest.id, 'assets'), data.asset)
                        : Buffer.from(String(data.data), 'base64');
                    display.kind = 'plot'; display.imageData = bytes.toString('base64');
                    display.resizable = false;
                    items[0] = vscode.NotebookCellOutputItem.json(display, DISPLAY_MIME);
                    items.push(new vscode.NotebookCellOutputItem(bytes, String(data.mime)));
                }
                if (data.kind === 'plot' || data.kind === 'image') {
                    const plotOutput = new vscode.NotebookCellOutput(items, { rDisplayId: data.displayId });
                    plots.push({ output: plotOutput, data: display }); outputs.push(plotOutput); continue;
                }
            }
            outputs.push(new vscode.NotebookCellOutput(items, { rDisplayId: data.displayId }));
        }
        if (plots.length > 1) {
            const first = plots[0];
            const key = `${view.client.manifest.id}:${cell.generation}:${String(first.data.displayId)}`;
            const gallery = { kind: 'plot', displayId: first.data.displayId, generation: cell.generation,
                connected: view.client.connected, archived: cell.generation !== view.model.generation,
                running: !['exited', 'stopping'].includes(view.client.manifest.status),
                pages: plots.map(plot => plot.data), selectedPlot: this.outputViews.get(key)?.selectedPlot };
            // Keep the gallery at the first plot's position. Other output retains
            // its order, and the journal keeps each page as an independent asset.
            const grouped = new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.json(gallery, DISPLAY_MIME),
                vscode.NotebookCellOutputItem.text(`${plots.length} R plot pages`),
                ...first.output.items.filter(item => item.mime.startsWith('image/'))], first.output.metadata);
            const plotOutputs = new Set(plots.map(plot => plot.output));
            return outputs.flatMap(output => output === first.output ? [grouped] : plotOutputs.has(output) ? [] : [output]);
        }
        return outputs;
    }

    private async render(view: InteractiveView, id: string): Promise<void> {
        if (view.disposed || view.notebook.isClosed) { return; }
        const data = this.transcriptCells(view).find(cell => cell.record.id === id);
        if (!data || !this.cell(view, id)) { return; }
        // Admission can precede R's start event by an arbitrary queue/startup delay.
        // Keep VS Code's execution pending; output mutation requires start().
        if (data.record.state === 'queued' || (view.executions.get(id)?.started === false && !data.outputs.length)) { return; }
        const outputs = await this.outputs(view, data);
        // Asset reads can outlive detach or reconnection. Re-read the live handle.
        if (view.disposed || view.notebook.isClosed) { return; }
        const cell = this.cell(view, id);
        if (!cell) { return; }
        const execution = view.executions.get(id);
        if (execution) {
            // A dispatch failure may have diagnostics but no R start event.
            if (!execution.started) { execution.task.start(data.record.started); execution.started = true; }
            await execution.task.replaceOutput(outputs);
        }
        else {
            // Updating a late plot must preserve the cell URI, edited code, selection, and diagnostics.
            const summary = cell.executionSummary;
            const update = view.controller.createNotebookCellExecution(cell);
            update.executionOrder = summary?.executionOrder;
            update.start(summary?.timing?.startTime);
            try { await update.replaceOutput(outputs); }
            finally { update.end(summary?.success, summary?.timing?.endTime); }
        }
    }

    private async prompt(view: InteractiveView, input: Record<string, unknown>): Promise<void> {
        const client = view.client;
        const id = Number(input.inputId);
        if (view.prompts.has(id) || view.disposed) { return; }
        view.prompts.add(id);
        const value = await vscode.window.showInputBox({ title: `${view.client.manifest.label}: R input`, prompt: String(input.prompt ?? 'Input'), ignoreFocusOut: true });
        if (view.client !== client) { return; }
        view.prompts.delete(id);
        if (value !== undefined && view.client === client && !view.restarting) {
            try { await view.client.request('input', { id, executionId: input.executionId, value }); }
            catch (error) { this.report(error); }
        }
    }

    private async resumeInput(view: InteractiveView): Promise<void> {
        const snapshot = await view.client.snapshot(1); if (snapshot.input) { await this.prompt(view, snapshot.input); }
    }

    private async clientRequest(view: InteractiveView, data: Record<string, unknown>): Promise<void> {
        const client = view.client;
        const params = object(data.params ?? {});
        try {
            const result = await session.handleEditorRequest(String(data.method), params);
            await client.request('clientReply', { id: data.id, result });
        } catch (error) { await client.request('clientReply', { id: data.id, error: String(error) }).catch(() => undefined); }
    }

    private async rendererMessage(editor: vscode.NotebookEditor, message: Record<string, unknown>): Promise<void> {
        const view = [...this.views.values()].find(item => item.notebook === editor.notebook);
        if (!view) { return; }
        const cells = this.transcriptCells(view).filter(cell => message.generation ? cell.generation === message.generation : cell.generation === view.model.generation);
        const owner = cells.find(cell => cell.outputs.some(item => item.type === 'display' && item.data.displayId === message.displayId));
        const output = owner?.outputs.find(item => item.type === 'display' && item.data.displayId === message.displayId);
        if (!owner || !output) { return; }
        const data = output.data;
        try {
            if ((message.action === 'tableView' && data.kind === 'table' && ['table', 'text'].includes(String(message.mode))) ||
                (message.action === 'plotPage' && ['plot', 'image'].includes(String(data.kind)) && owner?.outputs.some(item => item.type === 'display' &&
                    ['plot', 'image'].includes(String(item.data.kind)) && item.data.displayId === message.selectedPlot))) {
                const key = `${view.client.manifest.id}:${owner.generation}:${String(data.displayId)}`;
                const preference = message.action === 'tableView' ? { tableView: String(message.mode) } : { selectedPlot: String(message.selectedPlot) };
                this.outputViews.delete(key); this.outputViews.set(key, preference);
                while (this.outputViews.size > 1000) { this.outputViews.delete(this.outputViews.keys().next().value as string); }
                await this.context.workspaceState.update('r.interactive.outputViews', [...this.outputViews]);
                return;
            }
            if (['table', 'page', 'resize'].includes(String(message.action)) && ['exited', 'stopping'].includes(view.client.manifest.status)) {
                throw new Error('R has stopped. Start a new session and run the code again to use live controls.');
            }
            if (['table', 'page', 'resize'].includes(String(message.action)) && (view.restarting || owner?.generation !== view.model.generation)) {
                throw new Error('This output belongs to a previous R process. Run its code again to use live controls.');
            }
            let result: unknown;
            switch (message.action) {
                case 'table':
                    if (data.kind !== 'table') { return; }
                    await session.showDataView('table', 'json', `${view.client.manifest.label}: ${data.fullViewId ? 'full table' : 'table'}`, '', 'Beside', String(data.fullViewId ?? data.viewId), view.target); break;
                case 'page': {
                    if (data.kind !== 'table') { return; }
                    result = await queryTablePage(data, message, request => view.client.request('inspect', request)); break;
                }
                case 'resize':
                    if (data.kind !== 'plot') { return; }
                    await view.client.request('resize', { device: data.device, plot: data.plot, width: message.width, height: message.height }); break;
                case 'saveAs': {
                    if (!['plot', 'image'].includes(String(data.kind))) { return; }
                    const formats = [
                        ...(data.kind === 'plot' || data.mime === 'image/svg+xml' ? [{ label: 'SVG (.svg)', description: 'Scalable vector image', format: 'svg' }] : []),
                        ...(message.pngReady === true ? [{ label: 'PNG (.png)', description: 'Raster image', format: 'png' }] : []),
                    ];
                    result = (await vscode.window.showQuickPick(formats, { title: 'Save R plot as',
                        placeHolder: 'Choose an image format' }))?.format; break;
                }
                case 'save': case 'savePng': {
                    if (!['plot', 'image'].includes(String(data.kind))) { return; }
                    const png = message.action === 'savePng';
                    if (!png && data.kind === 'image' && data.mime !== 'image/svg+xml') { return; }
                    const pages = owner?.outputs.filter(item => item.type === 'display' && ['plot', 'image'].includes(String(item.data.kind))) ?? [];
                    const pageSuffix = pages.length > 1 ? `-${pages.indexOf(output) + 1}` : '';
                    const file = await vscode.window.showSaveDialog({
                        defaultUri: this.defaultExportUri(view, `plot-${owner?.record.order ?? 1}${pageSuffix}.${png ? 'png' : 'svg'}`),
                        filters: png ? { PNG: ['png'] } : { SVG: ['svg'] },
                    });
                    if (!file) { return; }
                    let bytes: Buffer;
                    if (png) {
                        if (typeof message.image !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(message.image) || message.image.length > 32 * 1024 * 1024) { throw new Error('Invalid PNG export'); }
                        bytes = Buffer.from(message.image.slice('data:image/png;base64,'.length), 'base64');
                    } else if (data.svg || data.asset) { bytes = readAsset(path.join(this.root, view.client.manifest.id, 'assets'), String(data.svg ?? data.asset)); }
                    else { bytes = Buffer.from(String(data.data), 'base64'); }
                    await vscode.workspace.fs.writeFile(file, bytes); break;
                }
                case 'plot': case 'open': {
                    await this.openOutput(view, data); break;
                }
            }
            await this.messages.postMessage({ outputId: message.outputId, action: message.action, requestId: message.requestId, result }, editor);
        } catch (error) { await this.messages.postMessage({ outputId: message.outputId, action: message.action, requestId: message.requestId, error: String(error) }, editor); }
    }

    private reconnect(view: InteractiveView, delay: number): void {
        if (view.disposed || this.closed || view.restarting) { return; }
        clearTimeout(view.reconnectTimer);
        view.reconnectTimer = setTimeout(() => {
            view.chain = view.chain.then(async () => {
                if (view.disposed || view.restarting) { return; }
                try {
                    const latest = discoverSessions(this.root).find(item => item.id === view.client.manifest.id);
                    if (latest && latest.generation !== view.model.generation) {
                        this.output.appendLine(`${latest.label}: a new R generation is available. Reconnect from Interactive Sessions.`);
                        return;
                    }
                    if (latest) { view.client.manifest = latest; }
                    await view.client.connect();
                    if (view.client.manifest.assetBase) {
                        view.base = (await vscode.env.asExternalUri(vscode.Uri.parse(view.client.manifest.assetBase))).toString(true);
                    }
                    if (!await view.client.subscribe(view.model.seq)) {
                        await this.restore(view, await view.client.snapshot()); await view.client.subscribe(view.model.seq);
                    }
                    if (this.active === view) { await this.activate(view); }
                } catch { this.reconnect(view, Math.min(delay * 2, 30000)); }
            });
        }, delay);
    }

    private async detach(view: InteractiveView): Promise<void> {
        try { if (view.client.connected) { await view.client.request('detach'); } }
        finally { this.disposeView(view); }
    }

    private async stop(view: InteractiveView): Promise<void> {
        const answer = await vscode.window.showWarningMessage(`Stop R session “${view.client.manifest.label}”? Its in-memory objects will be lost.`, { modal: true }, 'Stop Session');
        if (answer === 'Stop Session') { await view.client.request('stop'); }
    }

    private async stopMultiple(all: boolean, value?: unknown, selection?: unknown): Promise<void> {
        if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before stopping R sessions'); }
        const isManifest = (item: unknown): item is SessionManifest => !!item && typeof item === 'object'
            && typeof (item as SessionManifest).id === 'string' && typeof (item as SessionManifest).generation === 'string';
        // Tree actions can supply both the focused item and its selection; palette commands supply neither.
        const selected = !all && isManifest(value) ? Array.isArray(selection) && selection.length
            ? selection.filter(isManifest) : [value] : undefined;
        this.refresh();
        let targets = selected ?? await runningSessions(this.manifests);
        if (!all && !selected && targets.length) {
            const choices = targets.map(manifest => ({ label: manifest.label,
                description: this.sessionChoiceDescription(manifest),
                detail: `${manifest.directory} · ${manifest.host} · ${manifest.id.slice(0, 8)}`, manifest }));
            const picked = await vscode.window.showQuickPick(choices, { canPickMany: true, matchOnDescription: true, matchOnDetail: true,
                title: 'Stop Selected Interactive Sessions', placeHolder: 'Select the R sessions to stop' });
            if (!picked?.length) { return; }
            targets = picked.map(item => item.manifest);
        }
        // Freeze identities before confirmation: a restart or a newly created session must never become a target.
        targets = [...new Map(targets.filter(manifest => !['exited', 'stopping'].includes(manifest.status))
            .map(manifest => [`${manifest.id}:${manifest.generation}`, { ...manifest }])).values()];
        if (!targets.length) { void vscode.window.showInformationMessage('No running R Interactive sessions to stop.'); return; }
        const label = targets.length === 1 ? 'Stop Session' : `Stop ${targets.length} Sessions`;
        const detail = [
            'Their in-memory objects will be lost. Transcripts and saved output will be retained.',
            targets.map(manifest => `${manifest.label} — PID ${manifest.rPid ?? 'starting'} · ${manifest.id.slice(0, 8)}\n${manifest.directory}`).join('\n\n'),
            ...(targets.some(manifest => manifest.provider === 'arf-existing') ? ['Stopping an attached arf session also ends its R process.'] : []),
            'Sessions controlled by another VS Code window will be skipped. Take Control of those sessions before retrying.',
        ].join('\n\n');
        const confirmed = await vscode.window.showWarningMessage(`Stop ${targets.length} R Interactive session${targets.length === 1 ? '' : 's'}?`,
            { modal: true, detail }, label);
        if (confirmed !== label || this.closed) { return; }
        const stopped = new Set<string>();
        const failures: string[] = [];
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Stopping R Interactive sessions' }, async progress => {
            for (let i = 0; i < targets.length; i += 4) {
                const results = await Promise.allSettled(targets.slice(i, i + 4).map(async manifest => {
                    if (this.views.get(`${manifest.id}:${manifest.generation}`)?.restarting) { throw new Error('Session is restarting; retry when it is ready.'); }
                    await stopSession(manifest, this.clientId);
                }));
                results.forEach((result, index) => {
                    const manifest = targets[i + index];
                    if (result.status === 'fulfilled') { stopped.add(`${manifest.id}:${manifest.generation}`); }
                    else { failures.push(`${manifest.label} (PID ${manifest.rPid ?? 'starting'}): ${String(result.reason)}`); }
                });
                progress.report({ increment: results.length / targets.length * 100, message: `${i + results.length} of ${targets.length} checked` });
            }
        });
        this.refresh();
        // An unopened session's agent shuts down when the temporary client closes.
        // Its socket can still exist during refresh; do not leave an unusable tree link.
        this.manifests = this.manifests.filter(manifest => {
            const key = `${manifest.id}:${manifest.generation}`;
            return !stopped.has(key) || this.views.has(key);
        });
        this.changes.fire(undefined);
        const summary = `Stopped ${stopped.size} of ${targets.length} R Interactive sessions.`;
        if (failures.length) {
            this.output.appendLine(`${summary}\n${failures.join('\n')}`);
            const details = 'Show Details';
            if (await vscode.window.showWarningMessage(`${summary} ${failures.length} could not be stopped.`, details) === details) { this.output.show(true); }
        } else { void vscode.window.showInformationMessage(summary); }
    }

    private noticeData(view: InteractiveView, state: 'stopped' | 'restarting' | 'restarted' | 'restartFailed', generation = view.model.generation): vscode.NotebookCellData {
        const messages = {
            stopped: ['R session stopped', 'This R process has ended. The transcript is retained. Restart the session or choose another execution target to continue.'],
            restarting: ['Restarting R session…', 'The R process is being replaced. Your transcript and input stay in this window.'],
            restarted: ['R session restarted', 'Continue here in a fresh R process. Previous code and output are retained above; objects from the previous process are no longer available.'],
            restartFailed: ['R session restart did not complete', 'The previous transcript is retained. Check the R Interactive output channel and session list before trying again.'],
        };
        const [title, body] = messages[state];
        // appendText escapes spaces as NBSP; use it only for the untrusted session name.
        const markdown = new vscode.MarkdownString().appendMarkdown(`**${title}**\n\n`)
            .appendText(view.client.manifest.label).appendMarkdown(` — ${body}`);
        const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, markdown.value, 'markdown');
        data.metadata = { rSessionNotice: generation, rNoticeKind: state };
        return data;
    }

    private async sessionNotice(view: InteractiveView, state: Parameters<InteractiveManager['noticeData']>[1], generation = view.model.generation): Promise<void> {
        if (view.notebook.isClosed) { return; }
        const previous = view.notebook.getCells().find(cell => cell.metadata.rSessionNotice === generation);
        const data = this.noticeData(view, state, generation);
        const edit = new vscode.WorkspaceEdit();
        edit.set(view.notebook.uri, [previous
            ? vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(previous.index, previous.index + 1), [data])
            : vscode.NotebookEdit.insertCells(view.notebook.cellCount, [data])]);
        await vscode.workspace.applyEdit(edit);
    }

    private queueNotice(view: InteractiveView, state: Parameters<InteractiveManager['noticeData']>[1], generation = view.model.generation): Promise<void> {
        view.chain = view.chain.then(() => this.sessionNotice(view, state, generation));
        return view.chain;
    }

    private async restart(view: InteractiveView): Promise<void> {
        if (view.restarting) { return; }
        if (view.client.manifest.provider === 'arf-existing') { throw new Error('Restart adopted arf from its tmux terminal, then reconnect to the new process'); }
        view.restarting = true;
        this.updateStatus();
        const generation = view.model.generation;
        let announced = false;
        try {
            const answer = await vscode.window.showWarningMessage(`Restart R session “${view.client.manifest.label}”? Its in-memory objects will be lost. Code, output, and input will stay in this Interactive window.`, { modal: true }, 'Restart Session');
            if (answer !== 'Restart Session' || view.disposed) { return; }
            const storage = path.join(this.root, view.client.manifest.id);
            const config = JSON.parse(fs.readFileSync(path.join(storage, 'config.json'), 'utf8')) as AgentConfig;
            // Re-evaluate auto and honor repaired settings; the saved config records
            // the actual supervisor of the old process, not the current preference.
            config.supervision = util.config(vscode.Uri.file(config.directory)).get<string>('interactive.supervision', 'auto');
            prepareSupervisor(config.supervision, config.directory);
            const node = await this.nodeRuntime(config.directory, vscode.Uri.file(config.directory));
            if (config.provider === 'arf') {
                // Preserve the original binary across PATH changes after a reload, but
                // allow a repaired setting to replace a removed/moved executable.
                const command = resolveArfExecutable(config.arfPath ?? 'arf', config.directory)
                    ?? this.arfCommand(vscode.Uri.file(config.directory));
                config.arfPath = this.checkArfExecutable(command, config.directory, true);
                if (!config.arfPath) { return; }
            }
            const runtime = await installRuntime(this.context.extensionPath, this.root, config.rPath, text => this.output.append(text));
            config.library = runtime.library; config.resources = runtime.resources;
            config.maxAssetBytes = util.config().get<number>('interactive.maxAssetBytes', DEFAULT_MAX_ASSET_BYTES);
            config.previousGenerations = [...view.history.map(model => model.generation), generation];
            config.generation = randomUUID();
            if (view.disposed) { return; }
            if (config.provider === 'arf' && !this.checkArfExecutable(config.arfPath ?? 'arf', config.directory, true)) { return; }
            prepareSupervisor(config.supervision, config.directory);
            clearTimeout(view.reconnectTimer);
            announced = true;
            await this.queueNotice(view, 'restarting');
            if (view.client.connected) {
                await view.client.request('stop');
                // Wait for the old runtime to publish its final state before its successor.
                for (let i = 0; i < 100; i++) {
                    const state = await view.client.request<{ status: string }>('heartbeat');
                    if (state.status === 'exited') { break; }
                    if (i === 99) { throw new Error('The previous R process has not exited'); }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                await view.client.request('shutdown');
            } else if (view.client.manifest.status !== 'exited') {
                throw new Error('Reconnect to the R session before restarting it.');
            }
            await view.chain;
            clearTimeout(view.timer); view.timer = undefined; view.pending.clear();
            for (const { task } of view.executions.values()) { task.end(undefined); }
            view.executions.clear();
            view.client.close();
            const manifest = await launchAgent(config, runtime.agent, node, text => this.output.appendLine(text));
            if (view.disposed) { return; }
            this.views.delete(`${manifest.id}:${generation}`);
            view.history.push(view.model);
            view.model = new Transcript(manifest.generation);
            view.client = new AgentClient(manifest, this.clientId);
            this.views.set(`${manifest.id}:${manifest.generation}`, view);
            const target = this.registerTarget(view.client);
            session.replaceSessionTransport(view.target, target); view.target = target;
            this.listen(view, view.client);
            await view.client.connect();
            const deadline = Date.now() + 30000;
            while ((await view.client.request<{ status: string }>('heartbeat')).status === 'starting') {
                if (Date.now() >= deadline) { throw new Error('The replacement R process has not become ready'); }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            const snapshot = await view.client.snapshot();
            view.client.manifest = snapshot.manifest;
            target.pid = String(snapshot.manifest.rPid ?? ''); target.rVer = snapshot.manifest.rVersion ?? '';
            target.rPath = snapshot.manifest.rPath; target.libraryPaths = snapshot.manifest.libraryPaths;
            view.prompts.clear();
            if (snapshot.workspace) { target.workspaceData = snapshot.workspace as unknown as session.WorkspaceData; }
            view.base = snapshot.manifest.assetBase ? (await vscode.env.asExternalUri(vscode.Uri.parse(snapshot.manifest.assetBase))).toString(true) : '';
            view.model.restore(snapshot);
            const edit = new vscode.WorkspaceEdit();
            edit.set(view.notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata({ ...view.notebook.metadata, rSessionId: manifest.id, rGeneration: manifest.generation })]);
            await vscode.workspace.applyEdit(edit);
            await this.queueNotice(view, 'restarted', generation);
            if (view.model.cells.size) {
                const cells = await Promise.all([...view.model.cells.values()].map(cell => this.cellData(view, cell)));
                const insert = new vscode.WorkspaceEdit();
                insert.set(view.notebook.uri, [vscode.NotebookEdit.insertCells(view.notebook.cellCount, cells)]);
                await vscode.workspace.applyEdit(insert);
                for (const cell of view.notebook.getCells()) { session.bindSessionDocument(cell.document.uri, target); }
            }
            // Refresh asset URLs and disable process-specific controls without replacing old cells.
            for (const cell of this.transcriptCells(view)) {
                if (cell.outputs.some(output => output.type === 'display')) { await this.render(view, cell.record.id); }
            }
            if (snapshot.manifest.status === 'exited') { throw new Error('The replacement R process exited during startup'); }
            if (!await view.client.subscribe(view.model.seq)) { await this.restore(view, await view.client.snapshot()); await view.client.subscribe(view.model.seq); }
            if (this.active === view) { await this.activate(view); }
        } catch (error) {
            if (announced) { await this.queueNotice(view, 'restartFailed', generation); }
            throw error;
        } finally {
            view.restarting = false; this.refresh();
            if (!view.client.connected && view.client.manifest.status !== 'exited') { this.reconnect(view, 1000); }
        }
    }

    private async exportHistory(view: InteractiveView): Promise<void> {
        // macOS uses only the first save-dialog filter and otherwise appends .rnb
        // even when the user types another supported suffix. Choose the format first.
        const selected = await vscode.window.showQuickPick([
            { label: 'R Interactive notebook (.rnb)', description: 'Reopen cells and retained output in VS Code', format: 'rnb' },
            { label: 'Jupyter notebook (.ipynb)', description: 'Portable notebook with standard output formats', format: 'ipynb' },
            { label: 'R script (.R)', description: 'Code and session boundaries', format: 'R' },
            { label: 'HTML report (.html)', description: 'Share output and interactive widgets in a browser', format: 'html' },
        ], { title: `Export history: ${view.client.manifest.label}`, placeHolder: 'Choose an export format' });
        if (!selected) { return; }
        const file = await vscode.window.showSaveDialog({ defaultUri: this.defaultExportUri(view, `history.${selected.format}`),
            filters: { [selected.label]: [selected.format] } });
        if (!file) { return; }
        const entries = [...view.history, view.model].flatMap<TranscriptCell | string>(model =>
            [...model.cells.values(), ...(model === view.model ? [] : [model.generation])]);
        const cells = entries.filter((entry): entry is TranscriptCell => typeof entry !== 'string');
        if (selected.format === 'R') {
            await vscode.workspace.fs.writeFile(file, Buffer.from(entries.map(entry => typeof entry === 'string'
                ? '# R session restarted — fresh R process; previous objects are unavailable.'
                : `# %% ${entry.record.order}: ${entry.record.state}\n${entry.record.code}`).join('\n\n'))); return;
        }
        if (selected.format === 'html') {
            const sections: string[] = [];
            const assetFolder = `${file.fsPath}.assets`;
            const assets = new AssetStore(path.join(this.root, view.client.manifest.id, 'assets'));
            assets.exportTo(assetFolder, cells.flatMap(cell => cell.outputs.flatMap(output =>
                [output.data.svg, output.data.asset].filter((id): id is string => typeof id === 'string'))));
            for (const cell of entries) {
                if (typeof cell === 'string') {
                    sections.push('<p><strong>R session restarted</strong> — fresh R process; previous objects are unavailable.</p>'); continue;
                }
                sections.push(`<section><pre><code>${escapeXml(cell.record.code)}</code></pre>`);
                for (const output of cell.outputs) {
                    const data = output.data;
                    if (data.svg || data.asset) {
                        const url = `${encodeURIComponent(path.basename(assetFolder))}/${exportedAssetName(String(data.svg ?? data.asset))}`;
                        sections.push(data.svg || data.kind === 'image' ? `<img src="${escapeXml(url)}" style="max-width:100%">` : `<iframe sandbox="allow-scripts" src="${escapeXml(url)}" style="width:100%;height:500px;border:0"></iframe>`);
                    } else if (data.kind === 'table') {
                        const preference = this.outputViews.get(`${view.client.manifest.id}:${cell.generation}:${String(data.displayId)}`);
                        if ((preference?.tableView ?? util.config().get('interactive.tableView', 'table')) === 'text' && typeof data.printedText === 'string') {
                            sections.push(`<pre>${escapeXml(data.printedText)}</pre>`); continue;
                        }
                        const columns = data.columns as { field: string; headerName: string; type?: unknown }[];
                        const rows = data.rows as Record<string, unknown>[];
                        sections.push(`<table><tr>${columns.map(column => `<th style="text-align:${tableColumnAlignment(data, column)}">${escapeXml(column.headerName)}</th>`).join('')}</tr>${rows.map((row, rowIndex) => `<tr>${columns.map(column => `<td style="text-align:${tableColumnAlignment(data, column)}">${escapeXml(tableDisplayValue(data, row, column.field, rowIndex))}</td>`).join('')}</tr>`).join('')}</table><p>${tableSnapshotSummary(data) || `${String(data.totalRows)} rows (preview)`}</p>`);
                    } else if (data.kind === 'mime' && data.mime === 'text/html') {
                        sections.push(`<iframe sandbox="allow-scripts" srcdoc="${escapeXml(String(data.text))}" style="width:100%;height:500px;border:0"></iframe>`);
                    } else { sections.push(`<pre>${escapeXml(data.text ?? data.message ?? JSON.stringify(data, null, 2))}</pre>`); }
                }
                sections.push('</section>');
            }
            await vscode.workspace.fs.writeFile(file, Buffer.from(`<!doctype html><meta charset="utf-8"><title>R Interactive</title><style>body{max-width:1100px;margin:30px auto;font:14px system-ui}pre{white-space:pre-wrap;background:#f5f5f5;padding:16px}section{margin-bottom:32px}</style>${sections.join('\n')}`)); return;
        }
        const exported: vscode.NotebookCellData[] = [];
        for (const model of [...view.history, view.model]) {
            for (const cell of model.cells.values()) { exported.push(await this.cellData(view, cell, true)); }
            if (model !== view.model) { exported.push(this.noticeData(view, 'restarted', model.generation)); }
        }
        const notebook = new vscode.NotebookData(exported);
        notebook.metadata = { rSessionId: view.client.manifest.id, rGeneration: view.client.manifest.generation };
        await vscode.workspace.fs.writeFile(file, selected.format === 'ipynb' ? this.serializer.exportIpynb(notebook) : this.serializer.serializeNotebook(notebook));
    }

    private disposeView(view: InteractiveView, forget = true): void {
        if (view.disposed) { return; }
        view.disposed = true; clearTimeout(view.timer); clearTimeout(view.reconnectTimer);
        view.client.close(); for (const { task } of view.executions.values()) { task.end(undefined); }
        view.executions.clear();
        for (const controller of view.controllers) { controller.dispose(); }
        session.unregisterSessionTransport(view.target);
        this.views.delete(`${view.client.manifest.id}:${view.client.manifest.generation}`);
        if (this.active === view) {
            this.active = undefined; this.routing = false;
            this.status.hide();
            void vscode.commands.executeCommand('setContext', 'r.interactive.active', false);
            void vscode.commands.executeCommand('setContext', 'r.WorkspaceViewer:show', util.config().get<boolean>('sessionWatcher', false));
        }
        if (!this.closed && forget) {
            this.savedConnections.delete(view.client.manifest.id);
            void this.saveConnections();
        }
    }

    dispose(): void {
        this.closed = true; setInteractiveExecutor(undefined);
        for (const view of this.views.values()) { this.disposeView(view); }
        for (const disposable of this.disposables) { disposable.dispose(); }
        this.changes.dispose(); this.output.dispose();
    }
}
