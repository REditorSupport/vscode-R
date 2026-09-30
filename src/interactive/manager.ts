import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AgentClient } from './client';
import { AgentConfig, AgentSnapshot, SessionEvent, SessionManifest, SourceLocation, object } from './protocol';
import { defaultStorage, discoverSessions, installRuntime, launchAgent, newIdentity } from './launcher';
import { discoverArf, ArfSession } from './arf';
import { Transcript, TranscriptCell } from './transcript';
import { DISPLAY_MIME, InteractiveSerializer } from './notebook';
import { setInteractiveExecutor } from './executionTarget';
import * as session from '../session';
import * as util from '../util';
import { escapeXml } from './plotSvg';
import { ensureWorkspaceViewer } from '../extension';

interface InteractiveView {
    client: AgentClient;
    target: session.Session;
    model: Transcript;
    notebook: vscode.NotebookDocument;
    controller: vscode.NotebookController;
    controllers: vscode.NotebookController[];
    inputUri?: vscode.Uri;
    executions: Map<string, vscode.NotebookCellExecution>;
    chain: Promise<void>;
    pending: Set<string>;
    timer?: NodeJS.Timeout;
    reconnectTimer?: NodeJS.Timeout;
    disposed: boolean;
    prompts: Set<number>;
    base: string;
}

export class InteractiveManager implements vscode.Disposable, vscode.TreeDataProvider<SessionManifest> {
    private views = new Map<string, InteractiveView>();
    private opening = new Map<string, Promise<void>>();
    private active?: InteractiveView;
    private routing = false;
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

    constructor(private context: vscode.ExtensionContext) {
        this.root = util.config().get<string>('interactive.storagePath') || defaultStorage();
        this.clientId = randomUUID();
        const command = (name: string, handler: (...args: unknown[]) => unknown): void => {
            this.disposables.push(vscode.commands.registerCommand(name, (...args: unknown[]) =>
                Promise.resolve().then(() => handler(...args)).catch((error: unknown) => this.report(error))));
        };
        command('r.interactive.new', () => this.create());
        command('r.interactive.connect', () => this.pick());
        command('r.interactive.open', value => this.open(value as SessionManifest));
        command('r.interactive.refresh', () => this.refresh());
        command('r.interactive.interrupt', () => this.active?.client.request('interrupt'));
        command('r.interactive.input', () => this.active && this.resumeInput(this.active));
        command('r.interactive.detach', () => this.detach());
        command('r.interactive.stop', () => this.stop());
        command('r.interactive.restart', () => this.restart());
        command('r.interactive.takeControl', async () => {
            if (this.active) { this.active.client.control = await this.active.client.request<boolean>('claim', { force: true }); }
        });
        command('r.interactive.useTerminal', () => { this.routing = false; });
        command('r.interactive.bindDocument', () => {
            const document = vscode.window.activeTextEditor?.document;
            if (document && this.active) { session.bindSessionDocument(document.uri, this.active.target); }
        });
        command('r.interactive.export', () => this.exportHistory());
        command('r.interactive.clear', async () => {
            if (!this.active) { return; }
            const edit = new vscode.WorkspaceEdit();
            edit.set(this.active.notebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(0, this.active.notebook.cellCount))]);
            await vscode.workspace.applyEdit(edit);
        });
        this.disposables.push(vscode.window.registerTreeDataProvider('rInteractiveSessions', this),
            vscode.workspace.registerNotebookSerializer('r-interactive', this.serializer, { transientOutputs: false }),
            this.messages.onDidReceiveMessage(event => { void this.rendererMessage(event.editor, event.message as Record<string, unknown>); }),
            vscode.window.onDidChangeActiveNotebookEditor(editor => {
                const view = [...this.views.values()].find(item => item.notebook === editor?.notebook);
                if (view) { void this.activate(view); }
            }),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                const view = [...this.views.values()].find(item => item.inputUri?.toString() === editor?.document.uri.toString());
                if (view) { void this.activate(view); }
            }),
            vscode.workspace.onDidCloseNotebookDocument(document => {
                const view = [...this.views.values()].find(item => item.notebook === document);
                if (view) { this.disposeView(view); }
            }));
        setInteractiveExecutor(async (code, resource, source) => {
            const mode = util.config(resource).get<string>('interactive.executionTarget', 'auto');
            if (mode === 'terminal' || (!this.routing && mode !== 'interactive')) { return false; }
            const bound = resource && session.boundSessionForDocument(resource);
            const view = bound ? [...this.views.values()].find(item => item.target === bound) : this.active;
            if (!view) { throw new Error('Connect to an R Interactive session first'); }
            await this.submit(view, code, source); return true;
        });
        this.refresh();
        if (util.config().get<boolean>('interactive.restore', true)) {
            const saved = context.workspaceState.get<string[]>('r.interactive.sessions', []);
            for (const id of saved) {
                const manifest = this.manifests.find(item => item.id === id);
                if (manifest) { void this.open(manifest).catch(error => this.output.appendLine(`Restore ${manifest.label}: ${String(error)}`)); }
            }
        }
    }

    private report(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(message); void vscode.window.showErrorMessage(`R Interactive: ${message}`);
    }

    refresh(): void {
        try { this.manifests = discoverSessions(this.root); }
        catch (error) { this.manifests = []; this.report(error); }
        this.changes.fire(undefined);
    }
    getChildren(): SessionManifest[] { return this.manifests; }
    getTreeItem(manifest: SessionManifest): vscode.TreeItem {
        const item = new vscode.TreeItem(manifest.label);
        item.id = manifest.id; item.description = `${manifest.status} · ${manifest.provider}`;
        item.tooltip = `${manifest.directory}\n${manifest.rVersion ?? 'Starting R'}\nPID ${manifest.rPid ?? '—'} · ${manifest.supervision}`;
        item.iconPath = new vscode.ThemeIcon(manifest.status === 'busy' ? 'sync~spin' : manifest.status === 'exited' ? 'circle-outline' : 'terminal');
        item.command = { command: 'r.interactive.open', title: 'Open R Interactive', arguments: [manifest] };
        return item;
    }

    private async create(adopt?: ArfSession): Promise<void> {
        if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace before starting or controlling R'); }
        const resource = vscode.window.activeTextEditor?.document.uri;
        const rPath = await util.getRpath(false, resource);
        if (!rPath) { throw new Error('Configure an R executable before starting Interactive'); }
        const provider = adopt ? 'arf-existing' : await vscode.window.showQuickPick([
            { label: 'Plain R', description: 'Standard R with native console streaming', value: 'r' as const },
            { label: 'Headless arf', description: 'An independent arf session', value: 'arf' as const },
        ], { title: 'R Interactive session provider' });
        if (!provider) { return; }
        const kind = typeof provider === 'string' ? provider : provider.value;
        const directory = adopt?.cwd ?? vscode.workspace.getWorkspaceFolder(resource ?? vscode.Uri.file(this.root))?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? process.cwd();
        const label = await vscode.window.showInputBox({ title: 'Session name', value: adopt ? `arf ${adopt.pid}` : path.basename(directory) });
        if (!label) { return; }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting persistent R Interactive' }, async progress => {
            progress.report({ message: 'Preparing the private R runtime' });
            const runtime = await installRuntime(this.context.extensionPath, this.root, rPath, text => this.output.append(text));
            const identity = newIdentity();
            const config: AgentConfig = { ...identity, label, directory, storage: path.join(this.root, identity.id),
                rPath, library: runtime.library, resources: runtime.resources, provider: kind,
                arfPath: util.config().get<string>('interactive.arfPath', 'arf'), arfEndpoint: adopt?.socket_path,
                supervision: util.config().get<string>('interactive.supervision', 'auto'),
                plotBackend: util.config().get<AgentConfig['plotBackend']>('interactive.plotBackend', 'auto'),
                historyLimit: util.config().get<number>('interactive.historyLimit', 100),
                maxOutputBytes: util.config().get<number>('interactive.maxOutputBytes', 4 * 1024 * 1024),
                maxAssetBytes: util.config().get<number>('interactive.maxAssetBytes', 512 * 1024 * 1024),
                maxJournalBytes: util.config().get<number>('interactive.maxJournalBytes', 128 * 1024 * 1024) };
            progress.report({ message: 'Launching the independent session agent' });
            const manifest = await launchAgent(config, runtime.agent, util.config().get<string>('interactive.nodePath', 'node'));
            this.refresh(); await this.open(manifest);
        });
    }

    private async pick(): Promise<void> {
        this.refresh();
        const choices: (vscode.QuickPickItem & { manifest?: SessionManifest; arf?: ArfSession })[] =
            this.manifests.map(manifest => ({ label: manifest.label, description: `${manifest.status} · ${manifest.directory}`, manifest }));
        choices.push(...discoverArf().filter(arf => !this.manifests.some(item => item.rPid === arf.pid && item.status !== 'exited')).map(arf =>
            ({ label: `arf ${arf.pid}`, description: `${arf.r_version ?? ''} · ${arf.cwd ?? ''}`, arf })));
        const selected = await vscode.window.showQuickPick(choices, { title: 'Connect to a persistent R session' });
        if (selected?.manifest) { await this.open(selected.manifest); }
        else if (selected?.arf) { await this.create(selected.arf); }
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
        if (previous && !previous.notebook.isClosed) {
            await vscode.window.showNotebookDocument(previous.notebook, { preserveFocus: true }); await this.activate(previous); return;
        }
        const client = new AgentClient(manifest, this.clientId);
        const created: vscode.Disposable[] = [ { dispose: () => client.close() } ];
        try {
            await client.connect();
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
                controller.interruptHandler = () => client.request<void>('interrupt');
                created.push(controller);
                return controller;
            };
            const native = makeController('interactive');
            const fallback = makeController('r-interactive');
            let notebook: vscode.NotebookDocument;
            let inputUri: vscode.Uri | undefined;
            let controller = native;
            const existing = vscode.workspace.notebookDocuments.find(document =>
                document.metadata.rSessionId === manifest.id && document.metadata.rGeneration === manifest.generation);
            try {
                if (existing?.notebookType === 'r-interactive') { throw new Error('Restoring an R Interactive notebook'); }
                const result = await vscode.commands.executeCommand<{ notebookUri: vscode.Uri; inputUri: vscode.Uri }>(
                    'interactive.open', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, existing?.uri,
                    `${this.context.extension.id}/${native.id}`, `R: ${manifest.label}`);
                if (!result?.notebookUri || !result.inputUri) { throw new Error('Interactive Window returned no document'); }
                notebook = await vscode.workspace.openNotebookDocument(result.notebookUri); inputUri = result.inputUri;
            } catch (error) {
                this.output.appendLine(`Using notebook fallback: ${String(error)}`);
                controller = fallback;
                notebook = existing?.notebookType === 'r-interactive' ? existing : await vscode.workspace.openNotebookDocument('r-interactive', new vscode.NotebookData([]));
                fallback.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
                await vscode.window.showNotebookDocument(notebook, { preserveFocus: true });
            }
            const target = session.registerSessionTransport(key, manifest.host, manifest.directory, data =>
                client.request('inspect', { method: data.method, params: data.params ?? {} }, data.method === 'hover' || data.method === 'completion' ? 250 : 6000));
            target.pid = String(manifest.rPid ?? ''); target.rVer = manifest.rVersion ?? '';
            target.rPath = client.manifest.rPath; target.libraryPaths = client.manifest.libraryPaths;
            session.bindSessionDocument(vscode.Uri.from({ scheme: 'vscode-notebook-cell', path: notebook.uri.path }), target);
            const view: InteractiveView = { client, target, model: new Transcript(manifest.generation), notebook, controller,
                controllers: [native, fallback], inputUri, executions: new Map(), chain: Promise.resolve(),
                pending: new Set(), disposed: false, prompts: new Set(), base: '' };
            this.views.set(key, view);
            if (inputUri) {
                session.bindSessionDocument(inputUri, target);
                await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(inputUri), 'r');
            }
            await this.restore(view, await client.snapshot());
            client.on('event', (event: SessionEvent) => {
                view.chain = view.chain.then(() => this.event(view, event)).catch(error => this.report(error));
            });
            client.on('disconnect', () => this.reconnect(view, 1000));
            if (!await client.subscribe(view.model.seq)) { await this.restore(view, await client.snapshot()); await client.subscribe(view.model.seq); }
            await this.activate(view);
            await this.context.workspaceState.update('r.interactive.sessions', [...new Set([...this.views.values()].map(item => item.client.manifest.id))]);
        } catch (error) {
            const view = this.views.get(key);
            if (view) { this.disposeView(view); }
            else { created.forEach(item => { item.dispose(); }); }
            throw error;
        }
    }

    private async restore(view: InteractiveView, snapshot: AgentSnapshot): Promise<void> {
        for (const task of view.executions.values()) { task.end(undefined); }
        view.executions.clear();
        for (const cell of view.notebook.getCells()) { session.unbindSessionDocument(cell.document.uri); }
        view.client.manifest = snapshot.manifest;
        view.target.rPath = snapshot.manifest.rPath; view.target.libraryPaths = snapshot.manifest.libraryPaths;
        view.base = snapshot.manifest.assetBase ? (await vscode.env.asExternalUri(vscode.Uri.parse(snapshot.manifest.assetBase))).toString(true) : '';
        view.model.restore(snapshot);
        if (snapshot.workspace) { view.target.workspaceData = snapshot.workspace as unknown as session.WorkspaceData; }
        const cells: vscode.NotebookCellData[] = [];
        for (const cell of view.model.cells.values()) { cells.push(await this.cellData(view, cell)); }
        if (view.notebook.notebookType === 'r-interactive') { cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'r')); }
        const edit = new vscode.WorkspaceEdit();
        edit.set(view.notebook.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(0, view.notebook.cellCount), cells),
            vscode.NotebookEdit.updateNotebookMetadata({ rSessionId: snapshot.manifest.id, rGeneration: snapshot.manifest.generation })]);
        await vscode.workspace.applyEdit(edit);
        for (const cell of view.notebook.getCells()) { session.bindSessionDocument(cell.document.uri, view.target); }
        if (snapshot.input && view.client.control) { void this.prompt(view, snapshot.input); }
    }

    private async activate(view: InteractiveView): Promise<void> {
        this.active = view; this.routing = true;
        ensureWorkspaceViewer();
        await vscode.commands.executeCommand('setContext', 'r.WorkspaceViewer:show', true);
        await session.activateSession(view.target);
        await vscode.commands.executeCommand('setContext', 'r.interactive.active', true);
    }

    private cell(view: InteractiveView, id: string): vscode.NotebookCell | undefined {
        return view.notebook.getCells().find(cell => cell.metadata.rExecutionId === id);
    }

    private async submit(view: InteractiveView, code: string, source?: SourceLocation): Promise<void> {
        if (!code.trim()) { return; }
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
        if (!view.client.control) { throw new Error('Take control of this session before executing'); }
        for (const cell of cells) {
            const code = cell.document.getText(); if (!code.trim()) { continue; }
            // Re-running creates a new execution identity, even if the same cell is selected.
            const previousId = cell.metadata.rExecutionId as string | undefined;
            if (previousId && view.model.cells.has(previousId)) {
                await this.submit(view, code, cell.metadata.rSource as SourceLocation | undefined);
                continue;
            }
            const id = previousId && !view.model.cells.has(previousId) ? previousId : randomUUID();
            const source = cell.metadata.rSource as SourceLocation | undefined;
            const edit = new vscode.WorkspaceEdit();
            edit.set(view.notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cell.index, { ...cell.metadata, rExecutionId: id })]);
            await vscode.workspace.applyEdit(edit);
            session.bindSessionDocument(cell.document.uri, view.target);
            const task = view.controller.createNotebookCellExecution(cell); view.executions.set(id, task);
            try { await view.client.request('submit', { submission: { id, code, source } }); }
            catch (error) {
                // Query by the same ID; never resubmit code after an ambiguous transport failure.
                this.output.appendLine(`Submission ${id}: ${String(error)}`);
                task.end(undefined); view.executions.delete(id); throw error;
            }
        }
    }

    private async event(view: InteractiveView, event: SessionEvent): Promise<void> {
        if (view.disposed || event.generation !== view.model.generation || event.seq <= view.model.seq) { return; }
        const changed = view.model.apply(event);
        if (event.type === 'state') {
            view.client.manifest.status = event.data.status as SessionManifest['status'];
            view.target.pid = String(event.data.rPid ?? ''); view.target.rVer = String(event.data.rVersion ?? '');
            this.refresh();
        } else if (event.type === 'workspace') {
            view.target.workspaceData = event.data as unknown as session.WorkspaceData;
            if (this.active === view) { await session.activateSession(view.target); }
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
        if (!changed) { return; }
        if (!this.cell(view, changed)) {
            const data = await this.cellData(view, view.model.cells.get(changed)!);
            const edit = new vscode.WorkspaceEdit(); edit.set(view.notebook.uri, [vscode.NotebookEdit.insertCells(view.notebook.cellCount, [data])]);
            await vscode.workspace.applyEdit(edit);
        }
        if (event.type === 'started') {
            let execution = view.executions.get(changed);
            if (!execution) {
                try { execution = view.controller.createNotebookCellExecution(this.cell(view, changed)!); view.executions.set(changed, execution); }
                catch { /* Restored/observed execution can still display its retained state. */ }
            }
            if (execution) { execution.executionOrder = Number(event.data.order); execution.start(event.time); }
        }
        if (event.type === 'finished' || event.type === 'uncertain') {
            view.pending.delete(changed); await this.render(view, changed);
            const task = view.executions.get(changed);
            if (task) { task.end(event.data.state === 'success' ? true : event.data.state === 'error' ? false : undefined, event.time); view.executions.delete(changed); }
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

    private async cellData(view: InteractiveView, cell: TranscriptCell): Promise<vscode.NotebookCellData> {
        const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, cell.record.code, 'r');
        data.metadata = { rExecutionId: cell.record.id, rSource: cell.record.source, rState: cell.record.state };
        data.executionSummary = { executionOrder: cell.record.order,
            success: cell.record.state === 'success' ? true : cell.record.state === 'error' ? false : undefined,
            timing: cell.record.started && cell.record.ended ? { startTime: cell.record.started, endTime: cell.record.ended } : undefined };
        data.outputs = await this.outputs(view, cell);
        return data;
    }

    private async outputs(view: InteractiveView, cell: TranscriptCell): Promise<vscode.NotebookCellOutput[]> {
        const outputs: vscode.NotebookCellOutput[] = [];
        for (const output of cell.outputs) {
            const data = output.data;
            let items: vscode.NotebookCellOutputItem[];
            if (output.type === 'stream') {
                items = [data.channel === 'stderr' ? vscode.NotebookCellOutputItem.stderr(String(data.text)) : vscode.NotebookCellOutputItem.stdout(String(data.text))];
            } else if (output.type === 'condition') {
                items = data.kind === 'error' ? [vscode.NotebookCellOutputItem.error({ name: 'R error', message: String(data.message), stack: Array.isArray(data.trace) ? data.trace.join('\n') : '' })]
                    : [vscode.NotebookCellOutputItem.stderr(`${String(data.kind)}: ${String(data.message)}\n`)];
            } else if (output.type === 'truncated') { items = [vscode.NotebookCellOutputItem.text(String(data.message))]; }
            else if (data.kind === 'image' && typeof data.asset === 'string') {
                items = [new vscode.NotebookCellOutputItem(Buffer.from(await view.client.request<string>('asset', { id: data.asset }), 'base64'), String(data.mime))];
            } else if (data.kind === 'image') {
                items = [new vscode.NotebookCellOutputItem(Buffer.from(String(data.data), 'base64'), String(data.mime))];
            } else if (data.kind === 'mime' && data.mime !== 'text/html') {
                items = [vscode.NotebookCellOutputItem.text(String(data.text), String(data.mime))];
            } else {
                const display: Record<string, unknown> = { ...data };
                if (data.svg || data.asset) { display.url = view.base + String(data.svg ?? data.asset).split('/').map(encodeURIComponent).join('/'); }
                else if (typeof data.url === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(data.url)) {
                    display.url = (await vscode.env.asExternalUri(vscode.Uri.parse(data.url))).toString(true);
                }
                if (data.kind === 'mime' && data.mime === 'text/html') { display.kind = 'htmlText'; }
                items = [vscode.NotebookCellOutputItem.json(display, DISPLAY_MIME),
                    vscode.NotebookCellOutputItem.text(data.kind === 'table' ? `${String(data.totalRows)} rows\n${JSON.stringify(data.rows, null, 2)}` : `R ${String(data.kind)} output`)];
                if (typeof data.svg === 'string') {
                    try {
                        const svg = await view.client.request<string>('asset', { id: data.svg });
                        display.svgData = svg;
                        items[0] = vscode.NotebookCellOutputItem.json(display, DISPLAY_MIME);
                        items.push(new vscode.NotebookCellOutputItem(Buffer.from(svg, 'base64'), 'image/svg+xml'));
                    }
                    catch { /* The renderer can load a larger SVG directly from its asset URL. */ }
                }
            }
            outputs.push(new vscode.NotebookCellOutput(items, { rDisplayId: data.displayId }));
        }
        return outputs;
    }

    private async render(view: InteractiveView, id: string): Promise<void> {
        if (view.disposed || view.notebook.isClosed) { return; }
        const data = view.model.cells.get(id), cell = this.cell(view, id);
        if (!data || !cell) { return; }
        const task = view.executions.get(id);
        if (task) { await task.replaceOutput(await this.outputs(view, data)); }
        else {
            const edit = new vscode.WorkspaceEdit(); edit.set(view.notebook.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(cell.index, cell.index + 1), [await this.cellData(view, data)])]);
            session.unbindSessionDocument(cell.document.uri);
            await vscode.workspace.applyEdit(edit);
            const replacement = this.cell(view, id);
            if (replacement) { session.bindSessionDocument(replacement.document.uri, view.target); }
        }
    }

    private async prompt(view: InteractiveView, input: Record<string, unknown>): Promise<void> {
        const id = Number(input.inputId);
        if (view.prompts.has(id) || view.disposed) { return; }
        view.prompts.add(id);
        const value = await vscode.window.showInputBox({ title: `${view.client.manifest.label}: R input`, prompt: String(input.prompt ?? 'Input'), ignoreFocusOut: true });
        view.prompts.delete(id);
        if (value !== undefined) {
            try { await view.client.request('input', { id, executionId: input.executionId, value }); }
            catch (error) { this.report(error); }
        }
    }

    private async resumeInput(view: InteractiveView): Promise<void> {
        const snapshot = await view.client.snapshot(1); if (snapshot.input) { await this.prompt(view, snapshot.input); }
    }

    private async clientRequest(view: InteractiveView, data: Record<string, unknown>): Promise<void> {
        const params = object(data.params ?? {});
        try {
            const result = await session.handleEditorRequest(String(data.method), params);
            await view.client.request('clientReply', { id: data.id, result });
        } catch (error) { await view.client.request('clientReply', { id: data.id, error: String(error) }).catch(() => undefined); }
    }

    private async rendererMessage(editor: vscode.NotebookEditor, message: Record<string, unknown>): Promise<void> {
        const view = [...this.views.values()].find(item => item.notebook === editor.notebook);
        if (!view) { return; }
        const output = [...view.model.cells.values()].flatMap(cell => cell.outputs).find(item => item.type === 'display' && item.data.displayId === message.displayId);
        if (!output) { return; }
        const data = output.data;
        try {
            let result: unknown;
            switch (message.action) {
                case 'table':
                    if (data.kind !== 'table') { return; }
                    await session.showDataView('table', 'json', `${view.client.manifest.label}: table`, '', 'Beside', String(data.viewId), view.target); break;
                case 'page':
                    if (data.kind !== 'table') { return; }
                    result = await view.client.request('inspect', { method: 'dataview_page', params: { view_id: data.viewId,
                        startRow: Math.max(0, Number(message.start) || 0), endRow: Math.max(0, Number(message.start) || 0) + 100, sortModel: [], filterModel: {} } }); break;
                case 'resize':
                    if (data.kind !== 'plot') { return; }
                    await view.client.request('resize', { device: data.device, plot: data.plot, width: message.width, height: message.height }); break;
                case 'save': case 'savePng': {
                    if (data.kind !== 'plot') { return; }
                    const png = message.action === 'savePng';
                    const file = await vscode.window.showSaveDialog({ filters: png ? { PNG: ['png'] } : { SVG: ['svg'] } });
                    if (!file) { return; }
                    let bytes: Buffer;
                    if (png) {
                        if (typeof message.image !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(message.image) || message.image.length > 32 * 1024 * 1024) { throw new Error('Invalid PNG export'); }
                        bytes = Buffer.from(message.image.slice('data:image/png;base64,'.length), 'base64');
                    } else { bytes = Buffer.from(await view.client.request<string>('asset', { id: data.svg }), 'base64'); }
                    await vscode.workspace.fs.writeFile(file, bytes); break;
                }
                case 'plot': case 'open': {
                    let url = data.svg || data.asset ? view.base + String(data.svg ?? data.asset) : String(data.url ?? '');
                    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url)) {
                        url = (await vscode.env.asExternalUri(vscode.Uri.parse(url))).toString(true);
                    }
                    const html = data.kind === 'mime' && data.mime === 'text/html';
                    if (!url && !html) { return; }
                    const panel = vscode.window.createWebviewPanel('rInteractiveOutput', `R: ${view.client.manifest.label}`, vscode.ViewColumn.Beside, { enableScripts: true });
                    panel.webview.html = `<!doctype html><html><body style="margin:0"><iframe sandbox="allow-scripts allow-forms allow-downloads" ${html ? `srcdoc="${escapeXml(String(data.text))}"` : `src="${escapeXml(url)}"`} style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe></body></html>`;
                    break;
                }
            }
            await this.messages.postMessage({ outputId: message.outputId, action: message.action, result }, editor);
        } catch (error) { await this.messages.postMessage({ outputId: message.outputId, error: String(error) }, editor); }
    }

    private reconnect(view: InteractiveView, delay: number): void {
        if (view.disposed || this.closed) { return; }
        clearTimeout(view.reconnectTimer);
        view.reconnectTimer = setTimeout(() => {
            view.chain = view.chain.then(async () => {
                if (view.disposed) { return; }
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

    private async detach(): Promise<void> {
        const view = this.active; if (!view) { return; }
        await view.client.request('detach'); this.disposeView(view);
    }

    private async stop(): Promise<void> {
        const view = this.active; if (!view) { return; }
        const answer = await vscode.window.showWarningMessage(`Stop R session “${view.client.manifest.label}”? Its in-memory objects will be lost.`, { modal: true }, 'Stop Session');
        if (answer === 'Stop Session') { await view.client.request('stop'); }
    }

    private async restart(): Promise<void> {
        const view = this.active; if (!view) { return; }
        if (view.client.manifest.provider === 'arf-existing') { throw new Error('Restart adopted arf from its tmux terminal, then reconnect to the new process'); }
        const answer = await vscode.window.showWarningMessage('Restart R with a new environment? The old transcript will remain available.', { modal: true }, 'Restart Session');
        if (answer !== 'Restart Session') { return; }
        await view.client.request('stop');
        const storage = path.join(this.root, view.client.manifest.id);
        const config = JSON.parse(fs.readFileSync(path.join(storage, 'config.json'), 'utf8')) as AgentConfig;
        config.generation = randomUUID();
        // Wait for the old runtime to finish updating its manifest before publishing its successor.
        for (let i = 0; i < 100; i++) {
            const state = await view.client.request<{ status: string }>('heartbeat');
            if (state.status === 'exited') { break; }
            if (i === 99) { throw new Error('The previous R process has not exited'); }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        await view.client.request('shutdown');
        this.disposeView(view);
        const runtime = await installRuntime(this.context.extensionPath, this.root, config.rPath, text => this.output.append(text));
        await this.open(await launchAgent(config, runtime.agent, util.config().get<string>('interactive.nodePath', 'node')));
    }

    private async exportHistory(): Promise<void> {
        const view = this.active; if (!view) { return; }
        const file = await vscode.window.showSaveDialog({ filters: { 'R Interactive notebook': ['rnb'], 'Jupyter notebook': ['ipynb'], 'R script': ['R'], 'HTML report': ['html'] } });
        if (!file) { return; }
        const cells = [...view.model.cells.values()];
        if (/\.r$/i.test(file.path)) {
            await vscode.workspace.fs.writeFile(file, Buffer.from(cells.map(cell => `# %% ${cell.record.order}: ${cell.record.state}\n${cell.record.code}`).join('\n\n'))); return;
        }
        if (/\.html?$/i.test(file.path)) {
            const sections: string[] = [];
            const assetFolder = `${file.fsPath}.assets`;
            fs.cpSync(path.join(this.root, view.client.manifest.id, 'assets'), assetFolder, { recursive: true });
            for (const cell of cells) {
                sections.push(`<section><pre><code>${escapeXml(cell.record.code)}</code></pre>`);
                for (const output of cell.outputs) {
                    const data = output.data;
                    if (data.svg || data.asset) {
                        const url = `${encodeURIComponent(path.basename(assetFolder))}/${String(data.svg ?? data.asset)}`;
                        sections.push(data.svg || data.kind === 'image' ? `<img src="${escapeXml(url)}" style="max-width:100%">` : `<iframe sandbox="allow-scripts" src="${escapeXml(url)}" style="width:100%;height:500px;border:0"></iframe>`);
                    } else if (data.kind === 'table') {
                        const columns = data.columns as { field: string; headerName: string }[];
                        const rows = data.rows as Record<string, unknown>[];
                        sections.push(`<table><tr>${columns.map(column => `<th>${escapeXml(column.headerName)}</th>`).join('')}</tr>${rows.map(row => `<tr>${columns.map(column => `<td>${escapeXml(row[column.field] ?? 'NA')}</td>`).join('')}</tr>`).join('')}</table><p>${String(data.totalRows)} rows (preview)</p>`);
                    } else if (data.kind === 'mime' && data.mime === 'text/html') {
                        sections.push(`<iframe sandbox="allow-scripts" srcdoc="${escapeXml(String(data.text))}" style="width:100%;height:500px;border:0"></iframe>`);
                    } else { sections.push(`<pre>${escapeXml(data.text ?? data.message ?? JSON.stringify(data, null, 2))}</pre>`); }
                }
                sections.push('</section>');
            }
            await vscode.workspace.fs.writeFile(file, Buffer.from(`<!doctype html><meta charset="utf-8"><title>R Interactive</title><style>body{max-width:1100px;margin:30px auto;font:14px system-ui}pre{white-space:pre-wrap;background:#f5f5f5;padding:16px}section{margin-bottom:32px}</style>${sections.join('\n')}`)); return;
        }
        const notebook = new vscode.NotebookData(await Promise.all(cells.map(cell => this.cellData(view, cell))));
        notebook.metadata = { rSessionId: view.client.manifest.id, rGeneration: view.client.manifest.generation };
        await vscode.workspace.fs.writeFile(file, file.path.endsWith('.ipynb') ? this.serializer.exportIpynb(notebook) : this.serializer.serializeNotebook(notebook));
    }

    private disposeView(view: InteractiveView): void {
        if (view.disposed) { return; }
        view.disposed = true; clearTimeout(view.timer); clearTimeout(view.reconnectTimer);
        view.client.close(); for (const task of view.executions.values()) { task.end(undefined); }
        for (const controller of view.controllers) { controller.dispose(); }
        session.unregisterSessionTransport(view.target);
        this.views.delete(`${view.client.manifest.id}:${view.client.manifest.generation}`);
        if (this.active === view) {
            this.active = undefined; this.routing = false;
            void vscode.commands.executeCommand('setContext', 'r.interactive.active', false);
            void vscode.commands.executeCommand('setContext', 'r.WorkspaceViewer:show', util.config().get<boolean>('sessionWatcher', false));
        }
        if (!this.closed) {
            void this.context.workspaceState.update('r.interactive.sessions', [...this.views.values()].map(item => item.client.manifest.id));
        }
    }

    dispose(): void {
        this.closed = true; setInteractiveExecutor(undefined);
        for (const view of this.views.values()) { this.disposeView(view); }
        for (const disposable of this.disposables) { disposable.dispose(); }
        this.changes.dispose(); this.output.dispose();
    }
}
