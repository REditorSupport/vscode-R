import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { SessionAgent } from '../../interactive/agent';
import { AgentClient } from '../../interactive/client';
import { InteractiveSerializer, DISPLAY_MIME } from '../../interactive/notebook';
import { AgentConfig, SessionManifest, DEFAULT_MAX_ASSET_BYTES } from '../../interactive/protocol';
import { AssetStorageStats, exportedAssetName, readAsset } from '../../interactive/assets';
import type { InteractiveManager } from '../../interactive/manager';
import type { GlobalEnvItem, WorkspaceDataProvider } from '../../workspaceViewer';
import type { WorkspaceData } from '../../session';

(process.platform === 'win32' ? suite.skip : suite)('Interactive VS Code integration', function () {
    this.timeout(60000);
    let root: string;
    const sourceDirectories: string[] = [];
    let previousRProfile: string | undefined;
    let previousStorage: string | undefined;
    let previousConnections: unknown;
    let agents: SessionAgent[];
    let manifests: SessionManifest[];
    let controller: vscode.NotebookController;
    suiteSetup(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-interactive-editor-'));
        previousStorage = vscode.workspace.getConfiguration('r').inspect<string>('interactive.storagePath')?.globalValue;
        await vscode.workspace.getConfiguration('r').update('interactive.storagePath', root, vscode.ConfigurationTarget.Global);
        // Reproduce the user profile setting that makes lintr read virtual cell paths.
        fs.writeFileSync(path.join(root, '.Rprofile'), 'options(languageserver.lint_cache = TRUE)\n');
        previousRProfile = process.env.R_PROFILE_USER;
        process.env.R_PROFILE_USER = path.join(root, '.Rprofile');
        fs.mkdirSync(path.join(root, 'library'));
        fs.cpSync(path.join(process.cwd(), 'sess'), path.join(root, 'sess'), { recursive: true });
        await promisify(execFile)('R', ['CMD', 'INSTALL', '--clean', `--library=${path.join(root, 'library')}`, path.join(root, 'sess')]);
        await vscode.extensions.getExtension('REditorSupport.r')?.activate();
        // Startup restoration may activate R before this suite configures its private
        // registry. Recreate only the manager, just as a host reload would do.
        const context = bundleContext();
        previousConnections = context.workspaceState.get('r.interactive.connections');
        await context.workspaceState.update('r.interactive.connections', []);
        recreateManager(context);
        agents = []; manifests = [];
        for (let i = 0; i < 2; i++) {
            const id = randomUUID();
            const config: AgentConfig = { id, generation: randomUUID(), label: `Editor test ${i}`,
                directory: root, storage: path.join(root, id), library: path.join(root, 'library'),
                rPath: 'R', resources: path.join(process.cwd(), 'R'), provider: 'r', supervision: 'detached',
                plotBackend: 'auto', historyLimit: 50, maxOutputBytes: 1048576, maxJournalBytes: 16777216 };
            const agent = new SessionAgent(config);
            agents.push(agent); manifests.push(await agent.start());
            fs.writeFileSync(path.join(config.storage, 'config.json'), JSON.stringify(config));
        }
    });
    suiteTeardown(async () => {
        if (previousRProfile === undefined) { delete process.env.R_PROFILE_USER; }
        else { process.env.R_PROFILE_USER = previousRProfile; }
        await vscode.commands.executeCommand('r.interactive.detach');
        await vscode.workspace.getConfiguration('r').update('interactive.storagePath', previousStorage, vscode.ConfigurationTarget.Global);
        await bundleContext().workspaceState.update('r.interactive.connections', previousConnections);
        agents?.forEach(agent => agent.close());
        await new Promise(resolve => setTimeout(resolve, 200));
        fs.rmSync(root, { recursive: true, force: true });
        sourceDirectories.forEach(directory => fs.rmSync(directory, { recursive: true, force: true }));
    });
    const until = async (predicate: () => boolean): Promise<void> => {
        const deadline = Date.now() + 20000;
        while (!predicate()) {
            if (Date.now() > deadline) { throw new Error('Timed out waiting for notebook execution'); }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    };
    function bundleContext(): vscode.ExtensionContext {
        return (createRequire(__filename)(path.join(process.cwd(), 'dist/extension')) as { extensionContext: vscode.ExtensionContext }).extensionContext;
    }
    function recreateManager(context: vscode.ExtensionContext): void {
        const manager = context.subscriptions.find(item => typeof (item as InteractiveManager).open === 'function') as InteractiveManager;
        assert.ok(manager);
        const Manager = (Object.getPrototypeOf(manager) as { constructor: typeof InteractiveManager }).constructor;
        manager.dispose(); context.subscriptions.splice(context.subscriptions.indexOf(manager), 1);
        context.subscriptions.push(new Manager(context));
    }
    test('cancels Open Interactive Session from the command palette without opening a notebook or reporting an error', async () => {
        const picker = sinon.stub(vscode.window, 'showQuickPick').resolves(undefined);
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const created = sinon.spy(vscode.notebooks, 'createNotebookController');
        try {
            await vscode.commands.executeCommand('r.interactive.open');
            sinon.assert.notCalled(errors);
            sinon.assert.calledOnce(picker);
            sinon.assert.notCalled(created);
        } finally { picker.restore(); errors.restore(); created.restore(); }
    });
    test('the status-bar picker excludes dead agents without deleting their retained history', async () => {
        const stale = { ...manifests[0], id: randomUUID(), label: 'Stale session', endpoint: path.join(root, 'missing', 'control.sock') };
        const storage = path.join(root, stale.id); fs.mkdirSync(storage);
        const manifest = path.join(storage, 'manifest.json');
        fs.writeFileSync(manifest, JSON.stringify(stale));
        fs.writeFileSync(path.join(storage, 'retained-history'), 'keep this history');
        const picker = sinon.stub(vscode.window, 'showQuickPick').resolves(undefined);
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        try {
            await vscode.commands.executeCommand('r.interactive.connect');
            sinon.assert.calledOnce(picker);
            const choices = await picker.firstCall.args[0] as (vscode.QuickPickItem & { manifest?: SessionManifest })[];
            assert.ok(!choices.some(choice => choice.manifest?.id === stale.id), 'A saved idle status does not make a dead agent connectable');
            for (const live of manifests) {
                const choice = choices.find(choice => choice.manifest?.id === live.id); assert.ok(choice);
                assert.ok(choice.description?.includes(`PID ${choice.manifest?.rPid ?? 'starting'}`), 'Identical session names must be distinguishable by PID');
            }
            assert.ok(choices.some(choice => choice.label.includes('New persistent R session')));
            assert.strictEqual(fs.readFileSync(path.join(storage, 'retained-history'), 'utf8'), 'keep this history');
            assert.ok(fs.existsSync(manifest));
            sinon.assert.notCalled(errors);
        } finally { picker.restore(); errors.restore(); fs.rmSync(storage, { recursive: true, force: true }); }
    });
    test('opens native Interactive without Jupyter and executes through its R kernel', async () => {
        const created = sinon.spy(vscode.notebooks, 'createNotebookController');
        try {
            await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
            const native = created.returnValues.find(value => value.notebookType === 'interactive');
            assert.ok(native); controller = native;
        } finally { created.restore(); }
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook, 'Session notebook was opened');
        assert.strictEqual(notebook.notebookType, 'interactive', 'Native Interactive API is available');
        const edit = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(0, [new vscode.NotebookCellData(vscode.NotebookCellKind.Code,
            'editor_value <- 42; cat("editor-stream"); data.frame(x=1:3); plot(1:3)', 'r')])]);
        await vscode.workspace.applyEdit(edit);
        await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }], document: notebook.uri });
        await until(() => notebook.getCells().some(cell => cell.executionSummary?.success === true));
        const items = notebook.cellAt(0).outputs.flatMap(output => output.items);
        assert.ok(items.some(item => Buffer.from(item.data).toString().includes('editor-stream')));
        assert.ok(items.some(item => item.mime === 'application/vnd.vscode-r.display+json'));
    });
    test('shows the error message alongside user calls in native cells and portable exports', async () => {
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        const index = notebook.cellCount;
        const code = 'error_inner <- function(x) sqrt(x); error_wrapper <- function(x) error_inner(x); error_wrapper("bad")';
        await vscode.commands.executeCommand('r.runSelection', code);
        await until(() => notebook.cellCount > index && notebook.cellAt(index).executionSummary?.success === false);
        const cell = notebook.cellAt(index);
        const item = cell.outputs.flatMap(output => output.items).find(output => output.mime === 'application/vnd.code.notebook.error');
        assert.ok(item);
        const error = JSON.parse(Buffer.from(item.data).toString()) as { name: string; message: string; stack: string };
        assert.match(error.message, /non-numeric argument/);
        assert.ok(!code.includes(error.message), 'The call text alone cannot explain this failure');
        assert.ok(error.stack.startsWith(`R error: ${error.message}\n`));
        assert.ok(error.stack.includes('error_wrapper("bad")'));
        assert.ok(error.stack.includes('error_inner(x)'));
        assert.ok(!error.stack.includes('withCallingHandlers'));

        const format = sinon.stub(vscode.window, 'showQuickPick');
        const save = sinon.stub(vscode.window, 'showSaveDialog');
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        try {
            for (const extension of ['rnb', 'ipynb']) {
                const file = path.join(root, `error-message.${extension}`);
                format.resolves({ label: extension, format: extension } as vscode.QuickPickItem);
                save.resolves(vscode.Uri.file(file));
                await vscode.commands.executeCommand('r.interactive.export', notebook.uri);
                sinon.assert.notCalled(errors);
                if (extension === 'rnb') {
                    const restored = new InteractiveSerializer().deserializeNotebook(fs.readFileSync(file));
                    const restoredError: vscode.NotebookCellOutputItem | undefined = restored.cells[index].outputs?.flatMap(output => output.items)
                        .find(output => output.mime === item.mime);
                    assert.ok(restoredError);
                    assert.deepStrictEqual(JSON.parse(Buffer.from(restoredError.data).toString()), error);
                } else {
                    const exported = JSON.parse(fs.readFileSync(file, 'utf8')) as {
                        cells: { outputs: { output_type: string; evalue: string; traceback: string[] }[] }[];
                    };
                    const exportedError = exported.cells[index].outputs.find(output => output.output_type === 'error');
                    assert.ok(exportedError);
                    assert.strictEqual(exportedError.evalue, error.message);
                    assert.strictEqual(exportedError.traceback.join('\n'), error.stack);
                }
            }
        } finally { format.restore(); save.restore(); errors.restore(); }
    });
    test('Open Interactive Session without arguments opens the chosen session even when another is active', async () => {
        const picker = sinon.stub(vscode.window, 'showQuickPick').resolves({ label: manifests[1].label, manifest: manifests[1] } as vscode.QuickPickItem);
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        try {
            await vscode.commands.executeCommand('r.interactive.open');
            sinon.assert.notCalled(errors);
            sinon.assert.calledOnce(picker);
            const choices = await picker.firstCall.args[0] as (vscode.QuickPickItem & { manifest?: SessionManifest })[];
            for (const manifest of manifests) { assert.ok(choices.some(choice => choice.manifest?.id === manifest.id)); }
            assert.ok(vscode.workspace.notebookDocuments.some(document => document.metadata.rSessionId === manifests[1].id));
            await vscode.commands.executeCommand('r.runSelection', 'cat("selected through Open Interactive Session")');
            const second = vscode.workspace.notebookDocuments.find(document => document.metadata.rSessionId === manifests[1].id);
            assert.ok(second);
            await until(() => second.getCells().some(cell => cell.executionSummary?.success === true &&
                cell.document.getText() === 'cat("selected through Open Interactive Session")'));
        } finally {
            picker.restore(); errors.restore();
            await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
        }
    });

    test('the kernel button shows session identity, process details and live activity', async () => {
        const manifest = manifests[0];
        await vscode.commands.executeCommand('r.interactive.open', manifest);
        await until(() => controller.label === `R: ${manifest.label} · idle`);
        assert.ok(controller.description?.includes(`PID ${manifest.rPid ?? ''}`));
        assert.ok(controller.detail?.includes(manifest.directory));
        assert.match(controller.description ?? '', /^R \d/);
        await new Promise<void>(resolve => setImmediate(resolve));
        const refreshed: string[] = [];
        const update = controller.updateNotebookAffinity.bind(controller);
        const affinity = sinon.stub(controller, 'updateNotebookAffinity').callsFake((notebook, value) => {
            assert.strictEqual(notebook.metadata.rSessionId, manifest.id);
            assert.strictEqual(value, vscode.NotebookControllerAffinity.Preferred);
            refreshed.push(controller.label);
            update(notebook, value);
        });
        const selectionEvents: boolean[] = [];
        const listener = controller.onDidChangeSelectedNotebooks(event => selectionEvents.push(event.selected));
        try {
            await vscode.commands.executeCommand('r.runSelection', 'Sys.sleep(0.4)');
            await until(() => refreshed.some(label => label.endsWith(' · busy')));
            await until(() => refreshed.at(-1)?.endsWith(' · idle') === true);
            assert.deepStrictEqual(selectionEvents, [], 'Presentation refresh must not deselect the execution kernel');
            affinity.resetHistory();
            // Repeated unchanged status updates must not continually rebuild the picker.
            const manager = bundleContext().subscriptions.find(item => typeof (item as InteractiveManager).open === 'function');
            const status = manager as unknown as { updateStatus(): void };
            status.updateStatus(); status.updateStatus();
            await new Promise<void>(resolve => setImmediate(resolve));
            sinon.assert.notCalled(affinity);
        } finally { listener.dispose(); affinity.restore(); }
    });

    test('refreshes a controller opened during startup when R becomes ready', async () => {
        const id = randomUUID();
        const ready = path.join(root, 'release-startup');
        const profile = path.join(root, 'startup.R');
        fs.writeFileSync(profile, `local({ deadline <- Sys.time() + 20; while (!file.exists(${JSON.stringify(ready)}) && Sys.time() < deadline) Sys.sleep(0.02) })\n`);
        const config = JSON.parse(fs.readFileSync(path.join(root, manifests[0].id, 'config.json'), 'utf8')) as AgentConfig;
        const agent = new SessionAgent({ ...config, id, generation: randomUUID(), label: 'Delayed startup', storage: path.join(root, id) });
        const previous = process.env.R_PROFILE_USER;
        const created = sinon.spy(vscode.notebooks, 'createNotebookController');
        let affinity: sinon.SinonSpy | undefined;
        try {
            process.env.R_PROFILE_USER = profile;
            const manifest = await agent.start();
            process.env.R_PROFILE_USER = previous;
            await vscode.commands.executeCommand('r.interactive.open', manifest);
            const native = created.returnValues.find(value => value.notebookType === 'interactive');
            assert.ok(native);
            assert.match(native.label, / · starting$/);
            await new Promise<void>(resolve => setImmediate(resolve));
            affinity = sinon.spy(native, 'updateNotebookAffinity');
            fs.writeFileSync(ready, 'ready');
            await until(() => native.label.endsWith(' · idle') && !!affinity?.called);
            assert.match(native.description ?? '', /^R \d.*PID \d/);
            // Selection must still execute in this same session after the refresh.
            await vscode.commands.executeCommand('r.runSelection', 'cat("startup refreshed")');
            const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === id);
            assert.ok(notebook);
            await until(() => notebook.getCells().some(cell => cell.executionSummary?.success === true));
            await vscode.commands.executeCommand('r.interactive.detach', notebook.uri);
        } finally {
            if (previous === undefined) { delete process.env.R_PROFILE_USER; }
            else { process.env.R_PROFILE_USER = previous; }
            fs.writeFileSync(ready, 'ready');
            affinity?.restore(); created.restore();
            const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === id);
            if (notebook) {
                await vscode.commands.executeCommand('r.interactive.detach', notebook.uri);
                // Detached native tabs remain open. Remove this fixture's association
                // so later tests cannot mistake it for a newly created live session.
                const edit = new vscode.WorkspaceEdit();
                edit.set(notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata({ rSessionId: null, rGeneration: null })]);
                await vscode.workspace.applyEdit(edit);
                await until(() => !notebook.metadata.rSessionId);
            }
            agent.close();
            await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
        }
    });
    test('restores multiple native tabs without metadata and keeps R alive across manager disposal', async () => {
        // Load the activated bundle's context/constructor, so execution routing and
        // command registration use the same module instances as the real extension.
        const context = bundleContext();
        const manager = context.subscriptions.find(item => typeof (item as InteractiveManager).open === 'function') as InteractiveManager;
        assert.ok(manager);
        const Manager = (Object.getPrototypeOf(manager) as { constructor: typeof InteractiveManager }).constructor;
        for (const manifest of manifests) { await vscode.commands.executeCommand('r.interactive.open', manifest); }
        const notebooks = manifests.map(manifest => {
            const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifest.id);
            assert.ok(notebook); return notebook;
        });
        const originalUris = notebooks.map(notebook => notebook.uri.toString());
        const groupCount = vscode.window.tabGroups.all.length;
        const saved = context.workspaceState.get<{ id: string; notebookUri: string }[]>('r.interactive.connections', []);
        for (let i = 0; i < manifests.length; i++) {
            assert.strictEqual(saved.find(item => item.id === manifests[i].id)?.notebookUri, originalUris[i]);
        }
        await vscode.commands.executeCommand('r.runSelection', 'survives_editor_reload <- 73');
        await until(() => notebooks[1].getCells().some(cell => cell.document.getText() === 'survives_editor_reload <- 73' && cell.executionSummary?.success));
        manager.dispose();
        context.subscriptions.splice(context.subscriptions.indexOf(manager), 1);
        assert.deepStrictEqual(context.workspaceState.get('r.interactive.connections'), saved, 'Shutdown must retain saved connections');
        // Native VS Code reload restores the tabs/URIs, but drops their metadata.
        const reset = new vscode.WorkspaceEdit();
        for (const notebook of notebooks) {
            reset.set(notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata({ rSessionId: null, rGeneration: null })]);
        }
        await vscode.workspace.applyEdit(reset);
        await until(() => notebooks.every(notebook => !notebook.metadata.rSessionId));
        const created = sinon.spy(vscode.notebooks, 'createNotebookController');
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        try {
            const restoredManager = new Manager(context);
            context.subscriptions.push(restoredManager);
            await until(() => notebooks.every((notebook, i) => notebook.metadata.rSessionId === manifests[i].id));
            const native = created.returnValues.find(item => item.notebookType === 'interactive' && item.id.includes(manifests[0].id));
            assert.ok(native); controller = native;
            await vscode.commands.executeCommand('r.interactive.open', manifests[1]);
            // Execute in that native input explicitly: preserved source/input focus
            // can legitimately remain bound to another session after a background open.
            const result = await vscode.commands.executeCommand<{ inputUri: vscode.Uri }>('interactive.open', { preserveFocus: true }, notebooks[1].uri);
            const input = await vscode.workspace.openTextDocument(result.inputUri);
            const code = new vscode.WorkspaceEdit();
            code.replace(input.uri, new vscode.Range(0, 0, input.lineCount, 0), 'stopifnot(survives_editor_reload == 73)');
            await vscode.workspace.applyEdit(code);
            await vscode.commands.executeCommand('interactive.execute', notebooks[1].uri);
            await until(() => notebooks[1].getCells().some(cell => cell.document.getText() === 'stopifnot(survives_editor_reload == 73)' && cell.executionSummary?.success));
            assert.strictEqual(vscode.window.tabGroups.all.length, groupCount, 'Restoration must reuse existing editor groups');
            for (let i = 0; i < manifests.length; i++) {
                const matching = vscode.workspace.notebookDocuments.filter(doc => doc.metadata.rSessionId === manifests[i].id);
                assert.deepStrictEqual(matching.map(doc => doc.uri.toString()), [originalUris[i]]);
                const item = restoredManager.getTreeItem(manifests[i]);
                assert.match(String(item.tooltip), /Connection: Connected · controlling/);
                assert.match(String(item.tooltip), /Process supervision: Independent process/);
                assert.match(String(item.description), / · (<1m|\d+[mhd])/);
                assert.match(String(item.tooltip), /Started: /);
                assert.ok(!String(item.tooltip).includes('detached'));
            }
            sinon.assert.notCalled(errors);
        } finally {
            created.restore(); errors.restore();
            await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
        }
    });
    test('refreshes session tree connection and control details after reconnect and Take Control', async () => {
        const manager = bundleContext().subscriptions.find(item => typeof (item as InteractiveManager).open === 'function') as InteractiveManager;
        const view = (manager as unknown as { views: Map<string, { client: AgentClient }> }).views.get(`${manifests[0].id}:${manifests[0].generation}`);
        assert.ok(view);
        let refreshes = 0;
        const listener = manager.onDidChangeTreeData(() => refreshes++);
        const other = new AgentClient(manifests[0]);
        try {
            await other.connect(); await other.request('claim', { force: true });
            await view.client.connect();
            assert.ok(refreshes > 0, 'Connecting updates the session tree even without a state event');
            assert.match(String(manager.getTreeItem(manifests[0]).tooltip), /Connection: Connected · observing/);
            refreshes = 0;
            await vscode.commands.executeCommand('r.interactive.takeControl', manifests[0]);
            assert.ok(refreshes > 0, 'Taking control updates the tree immediately');
            assert.match(String(manager.getTreeItem(manifests[0]).tooltip), /Connection: Connected · controlling/);
            view.client.close();
            assert.match(String(manager.getTreeItem(manifests[0]).tooltip), /Connection: Disconnected/);
        } finally {
            other.close(); await view.client.connect(); await view.client.subscribe(0); listener.dispose();
        }
    });
    test('a session that disappears after selection reports a useful recovery message', async () => {
        const stale = { ...manifests[0], id: randomUUID(), label: 'Closed session', endpoint: path.join(root, 'missing.sock') };
        const picker = sinon.stub(vscode.window, 'showQuickPick').resolves({ label: stale.label, manifest: stale } as vscode.QuickPickItem);
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const count = vscode.workspace.notebookDocuments.length;
        try {
            await vscode.commands.executeCommand('r.interactive.connect');
            sinon.assert.calledOnce(errors);
            assert.match(errors.firstCall.args[0], /Closed session.*no longer available/);
            assert.match(errors.firstCall.args[0], /Refresh the session list/);
            assert.ok(!errors.firstCall.args[0].includes('ENOENT'));
            assert.strictEqual(vscode.workspace.notebookDocuments.length, count);
        } finally { picker.restore(); errors.restore(); }
    });
    test('lints Interactive cells and clears diagnostics after an edit', async () => {
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        const edit = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(notebook.cellCount, [
            new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'diagnostic_value<-1\n', 'r'),
        ])]);
        await vscode.workspace.applyEdit(edit);
        const document = notebook.cellAt(notebook.cellCount - 1).document;
        await until(() => vscode.languages.getDiagnostics(document.uri).length > 0);
        const diagnostics = vscode.languages.getDiagnostics(document.uri);
        assert.ok(!diagnostics.some(item => item.message.includes('Failed to run diagnostics')), JSON.stringify(diagnostics));
        assert.ok(diagnostics.some(item => item.message.includes('spaces around')));
        const fix = new vscode.WorkspaceEdit();
        fix.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), 'diagnostic_value <- 1\n');
        await vscode.workspace.applyEdit(fix);
        await until(() => vscode.languages.getDiagnostics(document.uri).length === 0);
    });
    test('namespace linters work on virtual cells and diagnostics keep their cell identity', async () => {
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        const index = notebook.cellCount;
        const edit = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(index, [
            new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'base::sum(1:3)\nnamespace_value<-1\n', 'r'),
            new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'base::sum(1:3)\n', 'r'),
        ])]);
        await vscode.workspace.applyEdit(edit);
        const bad = notebook.cellAt(index).document, good = notebook.cellAt(index + 1).document;
        await until(() => vscode.languages.getDiagnostics(bad.uri).length > 0);
        const diagnostics = vscode.languages.getDiagnostics(bad.uri);
        assert.ok(!diagnostics.some(item => item.message.includes('Failed to run diagnostics')), JSON.stringify(diagnostics));
        assert.ok(diagnostics.some(item => item.message.includes('spaces around') && item.range.start.line === 1));
        assert.deepStrictEqual(vscode.languages.getDiagnostics(good.uri), []);
        const fix = new vscode.WorkspaceEdit();
        fix.replace(bad.uri, new vscode.Range(0, 0, bad.lineCount, 0), 'base::sum(1:3)\nnamespace_value <- 1\n');
        await vscode.workspace.applyEdit(fix);
        await until(() => vscode.languages.getDiagnostics(bad.uri).length === 0);
    });

    test('lints the Interactive input before execution', async () => {
        const document = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'vscode-interactive-input' && doc.languageId === 'r');
        assert.ok(document);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), 'input_value<-1\n');
        await vscode.workspace.applyEdit(edit);
        await until(() => vscode.languages.getDiagnostics(document.uri).some(item =>
            item.message.includes('spaces around') || item.message.includes('Failed to run diagnostics')));
        const diagnostics = vscode.languages.getDiagnostics(document.uri);
        assert.ok(!diagnostics.some(item => item.message.includes('Failed to run diagnostics')), JSON.stringify(diagnostics));
        assert.ok(diagnostics.some(item => item.message.includes('spaces around')));
        const clear = new vscode.WorkspaceEdit();
        clear.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), 'input_value <- 1\n');
        await vscode.workspace.applyEdit(clear);
        await until(() => vscode.languages.getDiagnostics(document.uri).length === 0);
        const reset = new vscode.WorkspaceEdit();
        reset.delete(document.uri, new vscode.Range(0, 0, document.lineCount, 0));
        await vscode.workspace.applyEdit(reset);
    });
    test('provides live function hover in Interactive inputs as well as source documents', async () => {
        await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        const index = notebook.cellCount;
        const edit = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(index, [new vscode.NotebookCellData(vscode.NotebookCellKind.Code,
            'interactive_signature <- function(x, y) x + y', 'r')])]);
        await vscode.workspace.applyEdit(edit);
        await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: index, end: index + 1 }], document: notebook.uri });
        await until(() => notebook.cellAt(index).executionSummary?.success === true);
        const result = await vscode.commands.executeCommand<{ inputUri: vscode.Uri }>('interactive.open', { preserveFocus: true }, notebook.uri);
        const input = await vscode.workspace.openTextDocument(result.inputUri);
        const previous = input.getText();
        const text = new vscode.WorkspaceEdit();
        text.replace(input.uri, new vscode.Range(0, 0, input.lineCount, 0), 'interactive_signature');
        await vscode.workspace.applyEdit(text);
        try {
            const source = await vscode.workspace.openTextDocument({ language: 'r', content: 'interactive_signature' });
            for (const document of [source, input]) {
                const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', document.uri, new vscode.Position(0, 3));
                const text = hovers.flatMap(hover => hover.contents.map(content => typeof content === 'string' ? content : content.value)).join('\n');
                assert.ok(text.includes('function (x, y)'), `Missing live function hover in ${document.uri.scheme}: ${text}`);
            }
        } finally {
            const reset = new vscode.WorkspaceEdit(); reset.replace(input.uri, new vscode.Range(0, 0, input.lineCount, 0), previous);
            await vscode.workspace.applyEdit(reset);
        }
    });
    test('keeps blank Interactive prompts free of diagnostics while still linting nonempty input', async () => {
        const document = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'vscode-interactive-input' && doc.languageId === 'r');
        assert.ok(document);
        const previous = document.getText();
        const replace = async (text: string): Promise<void> => {
            const edit = new vscode.WorkspaceEdit(); edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
            await vscode.workspace.applyEdit(edit);
        };
        try {
            await replace('input_value <- 1\n\n');
            await until(() => vscode.languages.getDiagnostics(document.uri).some(item => item.message.includes('trailing blank lines')));
            await replace(' \n\t\n');
            await until(() => vscode.languages.getDiagnostics(document.uri).length === 0);
            // Let the server publish its whitespace diagnostics after the immediate clear.
            await new Promise(resolve => setTimeout(resolve, 1500));
            assert.deepStrictEqual(vscode.languages.getDiagnostics(document.uri), []);
            await replace('input_value<-1\n');
            await until(() => vscode.languages.getDiagnostics(document.uri).some(item => item.message.includes('spaces around')));
            await replace('');
            await until(() => vscode.languages.getDiagnostics(document.uri).length === 0);
        } finally { await replace(previous); }
    });
    test('uses each input owner for parameter hints and keeps live signatures available while R is busy', async () => {
        const inputs: vscode.TextDocument[] = [];
        const previous: string[] = [];
        const notebooks: vscode.NotebookDocument[] = [];
        const replace = async (document: vscode.TextDocument, code: string): Promise<void> => {
            const edit = new vscode.WorkspaceEdit(); edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), code);
            await vscode.workspace.applyEdit(edit);
        };
        const execute = async (notebook: vscode.NotebookDocument, code: string, wait = true): Promise<void> => {
            const index = notebook.cellCount;
            const edit = new vscode.WorkspaceEdit();
            edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(index, [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, 'r')])]);
            await vscode.workspace.applyEdit(edit);
            await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: index, end: index + 1 }], document: notebook.uri });
            if (wait) { await until(() => notebook.cellAt(index).executionSummary?.success === true); }
        };
        const help = async (document: vscode.TextDocument, expected: string, activeParameter: number, endOffset = 0): Promise<void> => {
            const deadline = Date.now() + 10000;
            for (;;) {
                const result = await vscode.commands.executeCommand<vscode.SignatureHelp | undefined>('vscode.executeSignatureHelpProvider',
                    document.uri, document.positionAt(document.getText().length + endOffset), ',');
                if (result?.signatures[0]?.label === expected) { assert.strictEqual(result.activeParameter, activeParameter); return; }
                if (Date.now() > deadline) { assert.fail(`Missing ${expected} in ${document.uri.scheme}: ${JSON.stringify(result)}`); }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        };
        try {
            for (let i = 0; i < 2; i++) {
                await vscode.commands.executeCommand('r.interactive.open', manifests[i]);
                const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[i].id);
                assert.ok(notebook); notebooks.push(notebook);
                await execute(notebook, i === 0 ? 'interactive_signature <- function(x, y) x + y'
                    : 'interactive_signature <- function(alpha, beta, gamma = 3) alpha + beta + gamma');
                const opened = await vscode.commands.executeCommand<{ inputUri: vscode.Uri }>('interactive.open', { preserveFocus: true }, notebook.uri);
                const input = await vscode.workspace.openTextDocument(opened.inputUri);
                inputs.push(input); previous.push(input.getText());
                await replace(input, 'interactive_signature(1, ');
            }
            await help(inputs[0], 'interactive_signature(x, y)', 1);
            await help(inputs[1], 'interactive_signature(alpha, beta, gamma = 3)', 1);
            await replace(inputs[1], 'interactive_signature(gamma = ');
            await help(inputs[1], 'interactive_signature(alpha, beta, gamma = 3)', 2);
            await execute(notebooks[0], 'Sys.sleep(1)', false);
            await until(() => manifests[0].status === 'busy');
            await help(inputs[0], 'interactive_signature(x, y)', 1);
            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', inputs[0].uri, new vscode.Position(0, 3));
            assert.ok(hovers.some(hover => hover.contents.some(content => typeof content !== 'string' && content.value.includes('function (x, y)'))));
            await until(() => manifests[0].status === 'idle');
            const source = await vscode.workspace.openTextDocument({ language: 'r', content: 'interactive_signature <- function(local_arg) local_arg\ninteractive_signature()' });
            await help(source, 'interactive_signature(local_arg)', 0, -1);
        } finally {
            for (let i = 0; i < inputs.length; i++) { await replace(inputs[i], previous[i]); }
            await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
        }
    });
    test('keeps source-file diagnostics working with lint caching enabled', async () => {
        // languageserver deliberately excludes files under the system temporary directory.
        const directory = fs.mkdtempSync(path.join(process.cwd(), '.r-interactive-source-'));
        try {
            const file = path.join(directory, 'diagnostics.R');
            fs.writeFileSync(file, 'file_value<-1\n');
            const document = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(file), 'r');
            await until(() => vscode.languages.getDiagnostics(document.uri).length > 0);
            const diagnostics = vscode.languages.getDiagnostics(document.uri);
            assert.ok(!diagnostics.some(item => item.message.includes('Failed to run diagnostics')), JSON.stringify(diagnostics));
            assert.ok(diagnostics.some(item => item.message.includes('spaces around')));
            const fix = new vscode.WorkspaceEdit();
            fix.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), 'file_value <- 1\n');
            await vscode.workspace.applyEdit(fix);
            await until(() => vscode.languages.getDiagnostics(document.uri).length === 0);
            await document.save();
        } finally { sourceDirectories.push(directory); }
    });
    test('reuses cell code in the input without executing it or replacing a draft', async () => {
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        const input = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'vscode-interactive-input' && doc.languageId === 'r');
        assert.ok(input);
        const draft = new vscode.WorkspaceEdit(); draft.insert(input.uri, new vscode.Position(0, 0), '# keep my draft');
        await vscode.workspace.applyEdit(draft);
        const client = new AgentClient(manifests[0]); await client.connect();
        try {
            const count = (await client.snapshot()).executions.length;
            const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => `${group.viewColumn}:${tab.label}`)).sort();
            const before = tabs();
            await vscode.commands.executeCommand('r.interactive.reuseCell', notebook.cellAt(0));
            assert.deepStrictEqual(tabs(), before, 'Cell reuse must keep the existing native Interactive tab');
            assert.ok(input.getText().startsWith('# keep my draft\n'));
            assert.ok(input.getText().includes('editor_value <- 42'));
            assert.strictEqual((await client.snapshot()).executions.length, count);
        } finally {
            client.close();
            const reset = new vscode.WorkspaceEdit(); reset.delete(input.uri, new vscode.Range(0, 0, input.lineCount, 0));
            await vscode.workspace.applyEdit(reset);
        }
    });
    test('late plot updates preserve the cell document, edited code, and execution summary', async function () {
        if (!manifests[0].capabilities.jgd) { this.skip(); }
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        const cell = notebook.cellAt(0);
        const plot = (): Record<string, unknown> | undefined => cell.outputs.flatMap(output => output.items)
            .filter(item => item.mime === DISPLAY_MIME).map(item => JSON.parse(Buffer.from(item.data).toString()) as Record<string, unknown>)
            .find(data => data.kind === 'plot');
        await until(() => !!plot());
        const initial = plot();
        assert.ok(initial);
        const uri = cell.document.uri.toString(), summary = cell.executionSummary;
        const code = cell.document.getText() + '\n# unsubmitted edit';
        const edit = new vscode.WorkspaceEdit();
        edit.replace(cell.document.uri, new vscode.Range(0, 0, cell.document.lineCount, 0), code);
        await vscode.workspace.applyEdit(edit);
        const client = new AgentClient(manifests[0]); await client.connect();
        try {
            await client.request('claim', { force: true });
            await client.request('resize', { device: initial.device, plot: initial.plot, width: 500, height: 350 });
            await until(() => plot()?.svg !== initial.svg);
            assert.strictEqual(notebook.cellAt(0).document.uri.toString(), uri);
            assert.strictEqual(notebook.cellAt(0).document.getText(), code);
            await until(() => cell.executionSummary?.success === true);
            assert.deepStrictEqual(cell.executionSummary, summary);
        } finally {
            await vscode.commands.executeCommand('r.interactive.takeControl', manifests[0]);
            client.close();
        }
    });
    test('queued cells wait for R to start before refreshing their output', async () => {
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        try {
            const index = notebook.cellCount;
            const edit = new vscode.WorkspaceEdit();
            edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(index, [
                new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'Sys.sleep(0.8); cat("first-complete")', 'r'),
                new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'cat("queued-complete"); data.frame(x=1:3)', 'r'),
            ])]);
            await vscode.workspace.applyEdit(edit);
            await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: index, end: index + 2 }], document: notebook.uri });
            await until(() => notebook.cellAt(index + 1).executionSummary?.success === true);
            assert.ok(notebook.cellAt(index + 1).outputs.some(output => output.items.some(item =>
                Buffer.from(item.data).toString().includes('queued-complete'))));
            sinon.assert.notCalled(errors);
        } finally { errors.restore(); }
    });
    test('cancelling queued cells completes their notebook execution without a start event', async () => {
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const client = new AgentClient(manifests[0]); await client.connect();
        try {
            const index = notebook.cellCount;
            const edit = new vscode.WorkspaceEdit();
            edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(index, [
                new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'Sys.sleep(1); cat("running-complete")', 'r'),
                new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'stop("cancelled code must not run")', 'r'),
            ])]);
            await vscode.workspace.applyEdit(edit);
            await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: index, end: index + 2 }], document: notebook.uri });
            const cancelled = notebook.cellAt(index + 1);
            await until(() => !!cancelled.metadata.rExecutionId && manifests[0].status === 'busy');
            // Let the normal output-refresh timer run while the second cell is queued.
            await new Promise(resolve => setTimeout(resolve, 150));
            await vscode.commands.executeCommand('r.interactive.cancelQueued', notebook.uri);
            await until(() => notebook.cellAt(index).executionSummary?.success === true);
            assert.strictEqual((await client.request<{ state: string }>('execution', { id: cancelled.metadata.rExecutionId })).state, 'cancelled');
            assert.strictEqual(cancelled.executionSummary?.success, undefined);
            assert.strictEqual(cancelled.outputs.length, 0);
            // A fresh handle is only allowed once the pending execution has ended.
            controller.createNotebookCellExecution(cancelled).end(undefined);
            sinon.assert.notCalled(errors);
        } finally { client.close(); errors.restore(); }
    });
    test('runs the diamonds data.table example through Send Selection without lifecycle errors', async function () {
        const packages = await promisify(execFile)('Rscript', ['-e',
            'cat(all(vapply(c("data.table", "ggplot2", "dplyr"), requireNamespace, logical(1), quietly=TRUE)))']);
        if (packages.stdout.trim() !== 'TRUE') { this.skip(); }
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        const code = String.raw`# R Script for Testing data.table with ggplot2 Diamonds Data
# ============================================================

library(data.table)
library(ggplot2)
library(dplyr)

# Load diamonds dataset as data.table
data(diamonds)
diamonds_dt <- as.data.table(diamonds)

cat("=== Data Overview ===\n")
cat("Dimensions:", nrow(diamonds_dt), "rows x", ncol(diamonds_dt), "columns\n")
cat("Column names:", colnames(diamonds_dt), "\n\n")

# Test 1: Basic Data Inspection
cat("=== Test 1: First few rows ===\n")
print(head(diamonds_dt, 3))
cat("\n")`;
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        try {
            await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
            const index = notebook.cellCount;
            // Send a slow command first to exercise the queue through the source-editor path.
            await vscode.commands.executeCommand('r.runSelection', 'Sys.sleep(0.8)');
            await until(() => notebook.cellCount > index && manifests[0].status === 'busy');
            await vscode.commands.executeCommand('r.runSelection', code);
            await until(() => notebook.cellCount > index + 1 && notebook.cellAt(index + 1).executionSummary?.success === true);
            const output = notebook.cellAt(index + 1).outputs.flatMap(item => item.items)
                .map(item => Buffer.from(item.data).toString()).join('\n');
            assert.match(output, /53940 rows x 10 columns/);
            assert.match(output, /First few rows/);
            assert.match(output, /0\.23/);
            sinon.assert.notCalled(errors);
        } finally { errors.restore(); }
    });
    test('Run Selection with no target offers live sessions and cancellation preserves the document and cursor', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'r', content: 'choice_cancelled <- 1\n2' });
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        await vscode.commands.executeCommand('r.interactive.useTerminal');
        const terminals = sinon.stub(vscode.window, 'terminals').value([]);
        const active = sinon.stub(vscode.window, 'activeTerminal').value(undefined);
        const picker = sinon.stub(vscode.window, 'showQuickPick').resolves(undefined);
        const create = sinon.spy(vscode.window, 'createTerminal');
        try {
            await vscode.commands.executeCommand('r.runSelection');
            sinon.assert.calledOnce(picker); sinon.assert.notCalled(create);
            assert.strictEqual(picker.firstCall.args[1]?.title, 'Run R code');
            const choices = await picker.firstCall.args[0] as (vscode.QuickPickItem & { manifest?: SessionManifest; create?: boolean; terminal?: boolean })[];
            assert.ok(choices.some(item => item.create)); assert.ok(choices.some(item => item.terminal));
            for (const manifest of manifests) { assert.ok(choices.some(item => item.manifest?.id === manifest.id)); }
            assert.strictEqual(document.getText(), 'choice_cancelled <- 1\n2');
            assert.strictEqual(editor.selection.active.line, 0);
            assert.strictEqual(editor.selection.active.character, 0);
        } finally { terminals.restore(); active.restore(); picker.restore(); create.restore(); }
    });

    test('Run Selection connects the chosen existing session and submits the captured code once', async () => {
        await vscode.commands.executeCommand('r.interactive.useTerminal');
        const terminals = sinon.stub(vscode.window, 'terminals').value([]);
        const picker = sinon.stub(vscode.window, 'showQuickPick').resolves({ label: manifests[1].label, manifest: manifests[1] } as vscode.QuickPickItem);
        try {
            await vscode.commands.executeCommand('r.runSelection', 'chosen_target_value <- 42');
            await vscode.commands.executeCommand('r.runSelection', 'chosen_target_value + 1');
            sinon.assert.calledOnce(picker);
            const client = new AgentClient(manifests[1]); await client.connect();
            try {
                const snapshot = await client.snapshot();
                assert.strictEqual(snapshot.executions.filter(record => record.code === 'chosen_target_value <- 42').length, 1);
                assert.ok(snapshot.executions.some(record => record.code === 'chosen_target_value + 1'));
            } finally { client.close(); }
        } finally { terminals.restore(); picker.restore(); await vscode.commands.executeCommand('r.interactive.open', manifests[0]); }
    });

    test('concurrent submissions share the target chooser and create only one R terminal', async () => {
        await vscode.commands.executeCommand('r.interactive.useTerminal');
        const terminals = sinon.stub(vscode.window, 'terminals').value([]);
        const active = sinon.stub(vscode.window, 'activeTerminal').value(undefined);
        const picker = sinon.stub(vscode.window, 'showQuickPick').callsFake(async () => {
            await new Promise(resolve => setTimeout(resolve, 20));
            return { label: 'Create R terminal', terminal: true } as vscode.QuickPickItem;
        });
        const sendText = sinon.spy();
        const terminal = { name: 'R Interactive', processId: Promise.resolve(undefined), show: () => undefined, sendText, dispose: () => undefined } as unknown as vscode.Terminal;
        const create = sinon.stub(vscode.window, 'createTerminal').returns(terminal);
        const configuration = vscode.workspace.getConfiguration('r');
        const watcher = configuration.inspect<boolean>('sessionWatcher')?.globalValue;
        await configuration.update('sessionWatcher', false, vscode.ConfigurationTarget.Global);
        try {
            await Promise.all([
                vscode.commands.executeCommand('r.runSelection', 'terminal_choice_one <- 1\nterminal_choice_one + 1'),
                vscode.commands.executeCommand('r.runSelection', 'terminal_choice_two <- 2\nterminal_choice_two + 1'),
            ]);
            sinon.assert.calledOnce(picker); sinon.assert.calledOnce(create);
            assert.deepStrictEqual(sendText.args.map(args => args[0] as string), [
                'terminal_choice_one <- 1', 'terminal_choice_one + 1', 'terminal_choice_two <- 2', 'terminal_choice_two + 1',
            ]);
        } finally {
            terminals.restore(); active.restore(); picker.restore(); create.restore();
            await configuration.update('sessionWatcher', watcher, vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
        }
    });

    test('Run Selection can create a persistent Interactive session and ordinary R exit leaves a restored notice', async () => {
        await vscode.commands.executeCommand('r.interactive.useTerminal');
        const terminals = sinon.stub(vscode.window, 'terminals').value([]);
        const picker = sinon.stub(vscode.window, 'showQuickPick').callsFake((_items, options) => Promise.resolve(
            options?.title === 'Run R code' ? { label: 'New R Interactive window', create: true } : { label: 'Plain R', value: 'r' }
        ) as ReturnType<typeof vscode.window.showQuickPick>);
        const input = sinon.stub(vscode.window, 'showInputBox').resolves('Created by Run Selection');
        let client: AgentClient | undefined;
        let notebook: vscode.NotebookDocument | undefined;
        try {
            await vscode.commands.executeCommand('r.runSelection', 'created_target_value <- 123');
            notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId && !manifests.some(item => item.id === doc.metadata.rSessionId));
            assert.ok(notebook);
            const manifest = JSON.parse(fs.readFileSync(path.join(root, String(notebook.metadata.rSessionId), 'manifest.json'), 'utf8')) as SessionManifest;
            client = new AgentClient(manifest); await client.connect();
            const snapshot = await client.snapshot();
            assert.strictEqual(snapshot.executions.filter(record => record.code === 'created_target_value <- 123').length, 1);
            await until(() => notebook?.getCells().some(cell => cell.executionSummary?.success === true) ?? false);
            await vscode.commands.executeCommand('r.runSelection', 'q("no")');
            await until(() => notebook?.getCells().some(cell => cell.metadata.rNoticeKind === 'stopped') ?? false);
            const uri = notebook.uri;
            await vscode.commands.executeCommand('r.interactive.detach', uri);
            await vscode.commands.executeCommand('r.interactive.open', manifest);
            assert.strictEqual(notebook.getCells().filter(cell => cell.metadata.rNoticeKind === 'stopped').length, 1);
            assert.ok(notebook.getCells().some(cell => cell.document.getText().includes('R session stopped')));
            assert.ok(notebook.getCells().some(cell => cell.document.getText().includes('The transcript is retained.')),
                'Notice body must keep breakable spaces so it wraps in narrow windows');
        } finally {
            terminals.restore(); picker.restore(); input.restore();
            if (notebook) { await vscode.commands.executeCommand('r.interactive.detach', notebook.uri); }
            if (client) {
                await client.request('claim', { force: true });
                await client.request('stop');
                for (let i = 0; i < 100 && (await client.request<{ status: string }>('heartbeat')).status !== 'exited'; i++) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                await client.request('shutdown'); client.close();
            }
            await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
        }
    });

    test('New Persistent Interactive Session focuses its own input and preserves the previous session draft', async () => {
        await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
        const original = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(original);
        const originalResult = await vscode.commands.executeCommand<{ inputUri: vscode.Uri }>('interactive.open', { preserveFocus: false }, original.uri);
        await vscode.commands.executeCommand('interactive.input.focus');
        await until(() => vscode.window.activeTextEditor?.document.uri.toString() === originalResult.inputUri.toString());
        const originalInput = vscode.window.activeTextEditor?.document;
        assert.strictEqual(originalInput?.uri.scheme, 'vscode-interactive-input');
        assert.ok(originalInput);
        const originalText = originalInput.getText();
        const draft = new vscode.WorkspaceEdit();
        draft.replace(originalInput.uri, new vscode.Range(0, 0, originalInput.lineCount, 0), '# unfinished work in the previous session');
        await vscode.workspace.applyEdit(draft);
        const before = new Set(vscode.workspace.notebookDocuments.map(doc => doc.uri.toString()));
        const inputsBefore = new Set(vscode.workspace.textDocuments.map(doc => doc.uri.toString()));
        const picker = sinon.stub(vscode.window, 'showQuickPick').resolves({ label: 'Plain R', value: 'r' } as vscode.QuickPickItem);
        const name = sinon.stub(vscode.window, 'showInputBox').resolves('New session focus');
        let notebook: vscode.NotebookDocument | undefined;
        let client: AgentClient | undefined;
        try {
            await vscode.commands.executeCommand('r.interactive.new');
            notebook = vscode.workspace.notebookDocuments.find(doc => !before.has(doc.uri.toString()) && doc.metadata.rSessionId);
            assert.ok(notebook);
            assert.strictEqual(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.label === 'R: New session focus').length, 1,
                'Focusing the new native input must not open a duplicate tab in the previous editor group');
            const manifest = JSON.parse(fs.readFileSync(path.join(root, String(notebook.metadata.rSessionId), 'manifest.json'), 'utf8')) as SessionManifest;
            client = new AgentClient(manifest); await client.connect();
            const input = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'vscode-interactive-input' && !inputsBefore.has(doc.uri.toString()));
            assert.ok(input);
            await until(() => vscode.window.activeTextEditor?.document.uri.toString() === input.uri.toString());
            assert.notStrictEqual(input.uri.toString(), originalInput.uri.toString());
            assert.strictEqual(originalInput.getText(), '# unfinished work in the previous session');
            const code = 'new_session_focus_value <- 123';
            const edit = new vscode.WorkspaceEdit(); edit.insert(input.uri, new vscode.Position(0, 0), code);
            await vscode.workspace.applyEdit(edit);
            await vscode.commands.executeCommand('interactive.execute', notebook.uri);
            await until(() => notebook?.getCells().some(cell => cell.document.getText() === code && cell.executionSummary?.success === true) ?? false);
            assert.ok(!original.getCells().some(cell => cell.document.getText() === code));
        } finally {
            picker.restore(); name.restore();
            if (notebook) { await vscode.commands.executeCommand('r.interactive.detach', notebook.uri); }
            if (client) {
                await client.request('claim', { force: true });
                await client.request('stop');
                for (let i = 0; i < 100 && (await client.request<{ status: string }>('heartbeat')).status !== 'exited'; i++) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                await client.request('shutdown'); client.close();
            }
            const restore = new vscode.WorkspaceEdit();
            restore.replace(originalInput.uri, new vscode.Range(0, 0, originalInput.lineCount, 0), originalText);
            await vscode.workspace.applyEdit(restore);
            await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
        }
    });

    test('history export chooses one format before saving and supports cancelling either step', async () => {
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        const picker = sinon.stub(vscode.window, 'showQuickPick').resolves(undefined);
        const save = sinon.stub(vscode.window, 'showSaveDialog').resolves(undefined);
        try {
            await vscode.commands.executeCommand('r.interactive.export', notebook.uri);
            sinon.assert.notCalled(save);
            const choices = picker.firstCall.args[0] as (vscode.QuickPickItem & { format: string })[];
            assert.deepStrictEqual(choices.map(choice => choice.format), ['rnb', 'ipynb', 'R', 'html']);
            for (const choice of choices) {
                picker.resolves(choice);
                await vscode.commands.executeCommand('r.interactive.export', notebook.uri);
                const options = save.lastCall.args[0];
                assert.deepStrictEqual(options?.filters, { [choice.label]: [choice.format] });
                assert.strictEqual(options?.defaultUri?.fsPath, path.join(root, `${manifests[0].label}-history.${choice.format}`));
            }
            assert.strictEqual(save.callCount, 4);
        } finally { picker.restore(); save.restore(); }
    });

    test('exports R-formatted numeric labels to HTML and retains raw numbers in saved notebooks', async () => {
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const saved = sinon.stub(vscode.window, 'showSaveDialog');
        const format = sinon.stub(vscode.window, 'showQuickPick').resolves({ label: 'HTML report', format: 'html' } as vscode.QuickPickItem);
        try {
            await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
            const index = notebook.cellCount;
            await vscode.commands.executeCommand('r.runSelection', 'options(digits=7, scipen=0); data.frame(price_per_carat=c(326/0.23, 326/0.21, 1400))');
            await until(() => notebook.cellCount > index && notebook.cellAt(index).executionSummary?.success === true);
            const htmlFile = path.join(root, 'numeric.html'); saved.resolves(vscode.Uri.file(htmlFile));
            await vscode.commands.executeCommand('r.interactive.export', notebook.uri);
            const html = fs.readFileSync(htmlFile, 'utf8');
            assert.ok(html.includes('<td>1417.391</td>') && html.includes('<td>1400.000</td>'));
            const notebookFile = path.join(root, 'numeric.rnb'); saved.resolves(vscode.Uri.file(notebookFile));
            format.resolves({ label: 'R Interactive notebook', format: 'rnb' } as vscode.QuickPickItem);
            await vscode.commands.executeCommand('r.interactive.export', notebook.uri);
            const report = new InteractiveSerializer().deserializeNotebook(fs.readFileSync(notebookFile));
            const table = report.cells.at(-1)?.outputs?.flatMap(output => output.items)
                .filter(item => item.mime === DISPLAY_MIME).map(item => JSON.parse(Buffer.from(item.data).toString()) as Record<string, unknown>)
                .find(data => data.kind === 'table');
            assert.ok(table);
            assert.deepStrictEqual(table.formattedColumns, { '1': ['1417.391', '1552.381', '1400.000'] });
            assert.ok(Math.abs((table.rows as Record<string, number>[])[0]['1'] - 326 / 0.23) < 1e-10);
            assert.strictEqual(table.connected, false);
            sinon.assert.notCalled(errors);
        } finally { errors.restore(); saved.restore(); format.restore(); }
    });
    test('exports large compressed plots to portable notebooks and ordinary SVG report assets', async function () {
        if (!manifests[0].capabilities.jgd) { this.skip(); }
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const saved = sinon.stub(vscode.window, 'showSaveDialog');
        const format = sinon.stub(vscode.window, 'showQuickPick');
        const info = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
        try {
            const index = notebook.cellCount;
            await vscode.commands.executeCommand('r.runSelection', 'plot(seq_len(22000), main="Large portable plot")');
            await until(() => notebook.cellCount > index && notebook.cellAt(index).executionSummary?.success === true);
            const plot = (): Record<string, unknown> | undefined => notebook.cellAt(index).outputs.flatMap(output => output.items)
                .filter(item => item.mime === DISPLAY_MIME).map(item => JSON.parse(Buffer.from(item.data).toString()) as Record<string, unknown>)
                .find(data => data.kind === 'plot');
            await until(() => !!plot());
            const display = plot(); assert.ok(display);
            const id = String(display.svg), assetRoot = path.join(root, manifests[0].id, 'assets');
            const svg = readAsset(assetRoot, id).toString();
            assert.ok(Buffer.byteLength(svg) > 2 * 1024 * 1024, 'Exercise plots too large for the asset RPC');
            assert.ok(id.endsWith('.svg.gz'));
            for (const extension of ['rnb', 'ipynb', 'html']) {
                const file = path.join(root, `report.${extension}`);
                saved.resolves(vscode.Uri.file(file));
                format.resolves({ label: extension, format: extension } as vscode.QuickPickItem);
                await vscode.commands.executeCommand('r.interactive.export', notebook.uri);
                sinon.assert.notCalled(errors);
                if (extension === 'html') {
                    assert.strictEqual(fs.readFileSync(path.join(file + '.assets', exportedAssetName(id)), 'utf8'), svg);
                    assert.ok(fs.readFileSync(file, 'utf8').includes(exportedAssetName(id)));
                } else if (extension === 'rnb') {
                    const report = new InteractiveSerializer().deserializeNotebook(fs.readFileSync(file));
                    assert.ok(report.cells.some(cell => cell.outputs?.some(output => output.items.some(item =>
                        item.mime === 'image/svg+xml' && Buffer.from(item.data).toString() === svg))));
                } else {
                    const report = JSON.parse(fs.readFileSync(file, 'utf8')) as { cells: { outputs: { data?: Record<string, string> }[] }[] };
                    assert.ok(report.cells.some(cell => cell.outputs.some(output => output.data?.['image/svg+xml'] === svg)));
                }
            }
            await vscode.commands.executeCommand('r.interactive.cleanAssets', notebook.uri);
            assert.ok(info.calledOnce);
            assert.strictEqual(readAsset(assetRoot, id).toString(), svg);
            sinon.assert.notCalled(errors);
        } finally { errors.restore(); saved.restore(); format.restore(); info.restore(); }
    });
    test('applies asset quota settings to connected sessions without restarting R', async () => {
        const configuration = vscode.workspace.getConfiguration('r');
        const previous = configuration.inspect<number>('interactive.maxAssetBytes')?.globalValue;
        const client = new AgentClient(manifests[0]); await client.connect();
        try {
            await configuration.update('interactive.maxAssetBytes', 64 * 1024 * 1024, vscode.ConfigurationTarget.Global);
            let stats: AssetStorageStats | undefined;
            const deadline = Date.now() + 10000;
            do {
                stats = await client.request<AssetStorageStats>('assetStorage');
                if (stats.limitBytes === 64 * 1024 * 1024) { break; }
                await new Promise(resolve => setTimeout(resolve, 50));
            } while (Date.now() < deadline);
            assert.strictEqual(stats.limitBytes, 64 * 1024 * 1024);
        } finally {
            await configuration.update('interactive.maxAssetBytes', previous, vscode.ConfigurationTarget.Global);
            client.close();
        }
    });
    test('clearing completed cells preserves drafts, running output, and durable history', async () => {
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        const index = notebook.cellCount;
        const edit = new vscode.WorkspaceEdit();
        edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(index, [
            new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'Sys.sleep(2); cat("retained-after-clear")', 'r'),
            new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '# unfinished draft', 'r'),
        ])]);
        await vscode.workspace.applyEdit(edit);
        await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: index, end: index + 1 }], document: notebook.uri });
        await until(() => manifests[0].status === 'busy');
        await vscode.commands.executeCommand('r.interactive.clear', notebook.uri);
        assert.ok(notebook.getCells().some(cell => cell.document.getText() === '# unfinished draft'));
        assert.ok(!notebook.getCells().some(cell => cell.document.getText().includes('editor_value <- 42')));
        await until(() => notebook.getCells().some(cell => cell.outputs.some(output => output.items.some(item =>
            Buffer.from(item.data).toString().includes('retained-after-clear')))));
        const client = new AgentClient(manifests[0]); await client.connect();
        try { assert.ok((await client.snapshot()).executions.some(record => record.code.includes('editor_value <- 42'))); }
        finally { client.close(); }
    });
    test('keeps independent notebooks and reconnects to the original R environment', async () => {
        await vscode.commands.executeCommand('r.interactive.open', manifests[1]);
        const documents = vscode.workspace.notebookDocuments.filter(doc => manifests.some(m => m.id === doc.metadata.rSessionId));
        assert.strictEqual(documents.length, 2);
        await vscode.commands.executeCommand('r.interactive.detach');
        await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
        const client = new AgentClient(manifests[0]);
        try {
            await client.connect();
            const snapshot = await client.snapshot();
            assert.ok(snapshot.executions.some(record => record.code.includes('editor_value')));
            assert.ok(snapshot.workspace?.globalenv);
        } finally { client.close(); }
    });
    test('Workspace follows native focus and bound sources, and actions retain their displayed owner', async () => {
        const workspace = (): WorkspaceDataProvider => (createRequire(__filename)(path.join(process.cwd(), 'dist/extension')) as { rWorkspace: WorkspaceDataProvider }).rWorkspace;
        const nodes = async (): Promise<GlobalEnvItem[]> => {
            const provider = workspace();
            const root = (await provider.getChildren()).find(item => item.id === 'globalenv');
            return await provider.getChildren(root) as GlobalEnvItem[];
        };
        const focus = async (index: number): Promise<void> => {
            await vscode.commands.executeCommand('r.interactive.open', manifests[index]);
            const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[index].id);
            assert.ok(notebook);
            await vscode.commands.executeCommand('interactive.open', { preserveFocus: false }, notebook.uri);
            await vscode.commands.executeCommand('interactive.input.focus');
            await until(() => workspace().owner?.sessionId === `${manifests[index].id}:${manifests[index].generation}`);
        };
        for (const index of [0, 1]) {
            await focus(index);
            await vscode.commands.executeCommand('r.runSelection', `workspace_marker <- rep(${index}, ${index + 1}); workspace_list <- list(owner = ${index})`);
            await until(() => workspace().data?.globalenv.workspace_marker?.length === index + 1);
        }
        await focus(0);
        const oldNode = (await nodes()).find(node => node.label === 'workspace_marker'); assert.ok(oldNode);
        const source = await vscode.workspace.openTextDocument({ language: 'r', content: 'workspace_marker' });
        await vscode.window.showTextDocument(source);
        await vscode.commands.executeCommand('r.interactive.bindDocument');
        await focus(1);
        await vscode.window.showTextDocument(source);
        await until(() => workspace().owner === oldNode.owner);
        assert.strictEqual(workspace().data?.globalenv.workspace_marker.length, 1);
        const list = (await nodes()).find(node => node.label === 'workspace_list'); assert.ok(list);
        const children = await workspace().getChildren(list);
        assert.ok(children.some(child => String(child.description).includes('0')));
        await focus(1);
        await vscode.commands.executeCommand('r.workspaceViewer.remove', oldNode);
        const firstClient = new AgentClient(manifests[0]); await firstClient.connect({ claim: false });
        try {
            let removed = false;
            const deadline = Date.now() + 10000;
            while (!removed && Date.now() < deadline) {
                removed = !((await firstClient.snapshot()).workspace as WorkspaceData | undefined)?.globalenv.workspace_marker;
                if (!removed) { await new Promise(resolve => setTimeout(resolve, 50)); }
            }
            assert.ok(removed, 'Remove applies to the displayed node owner');
            assert.strictEqual(workspace().owner?.sessionId, `${manifests[1].id}:${manifests[1].generation}`);
            assert.strictEqual(workspace().data?.globalenv.workspace_marker.length, 2);
        } finally { firstClient.close(); }
        // Closing/detaching an active view must not leave live-looking objects behind.
        await vscode.commands.executeCommand('r.interactive.detach', manifests[1]);
        assert.strictEqual(workspace().owner, undefined);
        assert.deepStrictEqual(await nodes(), []);
        await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
    });
    test('native toolbar actions target their notebook while another session is active', async () => {
        await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        await vscode.commands.executeCommand('r.interactive.open', manifests[1]);
        // VS Code serializes the notebook toolbar's editor to { notebookUri }.
        const target = { notebookEditor: { notebookUri: notebook.uri }, source: 'notebookToolbar', ui: true };
        const originalName = manifests[0].label;
        const otherName = manifests[1].label;
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const confirm = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        const picker = sinon.stub(vscode.window, 'showQuickPick').resolves({ label: 'Rename…', command: 'r.interactive.rename' } as vscode.QuickPickItem);
        const input = sinon.stub(vscode.window, 'showInputBox').resolves('Toolbar target');
        try {
            await vscode.commands.executeCommand('r.interactive.sessionActions', target);
            sinon.assert.notCalled(errors);
            assert.strictEqual(picker.firstCall.args[1]?.title, `Session: ${originalName}`);
            assert.strictEqual(input.firstCall.args[0]?.value, originalName);
            assert.strictEqual(manifests[0].label, 'Toolbar target');
            assert.strictEqual(manifests[1].label, otherName);
            await vscode.commands.executeCommand('r.interactive.restart', target);
            assert.match(confirm.lastCall.args[0], /Toolbar target/);
            await vscode.commands.executeCommand('r.interactive.stop', target);
            assert.match(confirm.lastCall.args[0], /Toolbar target/);
            assert.strictEqual(manifests[0].status, 'idle', 'Cancelling a confirmation must leave R alive');
            assert.strictEqual(manifests[1].status, 'idle');
            sinon.assert.notCalled(errors);
            await vscode.commands.executeCommand('r.interactive.rename', target, originalName);
        } finally { errors.restore(); confirm.restore(); picker.restore(); input.restore(); }
    });
    test('toolbar actions never fall back to another session for an unrelated notebook', async () => {
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const confirm = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        try {
            await vscode.commands.executeCommand('r.interactive.stop', {
                notebookEditor: { notebookUri: vscode.Uri.parse('untitled:unrelated.interactive') }, source: 'notebookToolbar', ui: true,
            });
            sinon.assert.calledOnce(errors);
            assert.match(errors.firstCall.args[0], /not connected to an R Interactive session/);
            sinon.assert.notCalled(confirm);
        } finally { errors.restore(); confirm.restore(); }
    });
    test('session actions target their tree entry even when another session is active', async () => {
        await vscode.commands.executeCommand('r.interactive.open', manifests[1]);
        const secondName = manifests[1].label;
        await vscode.commands.executeCommand('r.interactive.rename', manifests[0], 'Renamed first session');
        assert.strictEqual(manifests[0].label, 'Renamed first session');
        assert.strictEqual(manifests[1].label, secondName);
        await vscode.commands.executeCommand('r.interactive.detach', manifests[0]);
        const second = new AgentClient(manifests[1]); await second.connect();
        try { assert.strictEqual(second.control, false, 'The second session must remain controlled by its original window'); }
        finally { second.close(); }
    });
    test('Stop Session adds one notice to its own notebook and source execution can choose a live replacement', async () => {
        await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
        const source = await vscode.workspace.openTextDocument({ language: 'r', content: 'replacement_target_value <- 7' });
        await vscode.window.showTextDocument(source);
        await vscode.commands.executeCommand('r.interactive.bindDocument');
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        const confirmation = sinon.stub(vscode.window, 'showWarningMessage').resolves('Stop Session' as unknown as vscode.MessageItem);
        const picker = sinon.stub(vscode.window, 'showQuickPick').resolves({ label: manifests[1].label, manifest: manifests[1] } as vscode.QuickPickItem);
        const info = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
        try {
            await vscode.commands.executeCommand('r.interactive.stop', notebook.uri);
            await until(() => notebook.getCells().some(cell => cell.metadata.rNoticeKind === 'stopped'));
            const ended = manifests[0].ended;
            assert.ok(typeof ended === 'number' && ended >= manifests[0].created);
            assert.strictEqual((JSON.parse(fs.readFileSync(path.join(root, manifests[0].id, 'manifest.json'), 'utf8')) as SessionManifest).ended, ended);
            const notice = notebook.getCells().find(cell => cell.metadata.rNoticeKind === 'stopped');
            const drafts = vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'vscode-interactive-input');
            const contents = drafts.map(doc => doc.getText());
            await vscode.commands.executeCommand('r.interactive.reuseCell', notice);
            assert.deepStrictEqual(drafts.map(doc => doc.getText()), contents, 'A lifecycle notice must not become executable R code');
            assert.match(info.lastCall.args[0], /Select an R code cell/);
            await vscode.commands.executeCommand('r.interactive.source', notice);
            assert.match(info.lastCall.args[0], /no source location/);
            await vscode.commands.executeCommand('r.interactive.stop', notebook.uri);
            assert.strictEqual(manifests[0].ended, ended, 'Repeated Stop must not extend the recorded lifetime');
            assert.strictEqual(notebook.getCells().filter(cell => cell.metadata.rNoticeKind === 'stopped').length, 1);
            assert.notStrictEqual(manifests[1].status, 'exited');
            await vscode.commands.executeCommand('r.runSelection', 'replacement_target_value <- 7');
            sinon.assert.calledOnce(picker);
            const choices = await picker.firstCall.args[0] as (vscode.QuickPickItem & { manifest?: SessionManifest })[];
            assert.ok(!choices.some(item => item.manifest?.id === manifests[0].id));
            const client = new AgentClient(manifests[1]); await client.connect();
            try { assert.ok((await client.snapshot()).executions.some(record => record.code === 'replacement_target_value <- 7')); }
            finally { client.close(); }
        } finally { confirmation.restore(); picker.restore(); info.restore(); }
    });

    test('restart keeps the window, drafts, transcript, bindings and kernel through multiple R processes', async () => {
        const original = manifests[1];
        await vscode.commands.executeCommand('r.interactive.detach', original);
        const created = sinon.spy(vscode.notebooks, 'createNotebookController');
        let restartController: vscode.NotebookController;
        try {
            await vscode.commands.executeCommand('r.interactive.open', original);
            const native = created.returnValues.find(value => value.notebookType === 'interactive');
            assert.ok(native); restartController = native;
        } finally { created.restore(); }
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === original.id);
        assert.ok(notebook);
        const beforeCode = 'before_restart <- 42; cat("before restart"); data.frame(x=1:50); plot(1:3)';
        await vscode.commands.executeCommand('r.runSelection', beforeCode);
        await until(() => notebook.getCells().some(cell => cell.document.getText() === beforeCode && cell.executionSummary?.success === true));
        const oldCell = notebook.getCells().find(cell => cell.document.getText() === beforeCode);
        assert.ok(oldCell);
        const displays = (cell: vscode.NotebookCell): Record<string, unknown>[] => cell.outputs.flatMap(output => output.items)
            .filter(item => item.mime === DISPLAY_MIME).map(item => JSON.parse(Buffer.from(item.data).toString()) as Record<string, unknown>);
        await until(() => displays(oldCell).some(data => data.kind === 'plot'));
        const oldUri = oldCell.document.uri.toString();
        const oldId = oldCell.metadata.rExecutionId as string;
        const oldCount = notebook.cellCount;
        const windowCount = vscode.workspace.notebookDocuments.length;
        const input = await vscode.commands.executeCommand<{ inputUri: vscode.Uri }>('interactive.open',
            { preserveFocus: true }, notebook.uri, `REditorSupport.r/r-${original.id}-${original.generation}-interactive`);
        const draft = await vscode.workspace.openTextDocument(input.inputUri);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(draft.uri, new vscode.Position(0, 0), 'unsent_draft <- 99');
        edit.insert(oldCell.document.uri, oldCell.document.positionAt(oldCell.document.getText().length), '\n# edited after execution');
        await vscode.workspace.applyEdit(edit);
        const source = await vscode.workspace.openTextDocument({ language: 'r', content: 'cat("bound source")' });
        await vscode.window.showTextDocument(source, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
        await vscode.commands.executeCommand('r.interactive.bindDocument');
        let sawRestarting = false;
        const change = vscode.workspace.onDidChangeNotebookDocument(event => {
            if (event.notebook === notebook && event.notebook.getCells().some(cell => cell.metadata.rNoticeKind === 'restarting')) { sawRestarting = true; }
        });
        const confirmation = sinon.stub(vscode.window, 'showWarningMessage').resolves('Restart Session' as unknown as vscode.MessageItem);
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const kernels = sinon.spy(vscode.notebooks, 'createNotebookController');
        let client: AgentClient | undefined;
        const nodePath = vscode.workspace.getConfiguration('r').inspect<string>('interactive.nodePath')?.globalValue;
        try {
            // A cancelled restart must leave the process and transcript alone.
            confirmation.resolves(undefined);
            await vscode.commands.executeCommand('r.interactive.restart', notebook.uri);
            assert.strictEqual(notebook.cellCount, oldCount);
            assert.strictEqual(notebook.metadata.rGeneration, original.generation);
            confirmation.resolves('Restart Session' as unknown as vscode.MessageItem);
            // A launch failure after stopping R must retain the window and permit retry.
            await vscode.workspace.getConfiguration('r').update('interactive.nodePath', path.join(root, 'missing-node'), vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('r.interactive.restart', notebook.uri);
            sinon.assert.calledOnce(errors);
            assert.ok(notebook.getCells().some(cell => cell.metadata.rNoticeKind === 'restartFailed'));
            assert.strictEqual(oldCell.document.uri.toString(), oldUri);
            assert.strictEqual(draft.getText(), 'unsent_draft <- 99');
            await vscode.workspace.getConfiguration('r').update('interactive.nodePath', nodePath, vscode.ConfigurationTarget.Global);
            confirmation.resetHistory(); errors.resetHistory();
            await Promise.all([
                vscode.commands.executeCommand('r.interactive.restart', notebook.uri),
                vscode.commands.executeCommand('r.interactive.restart', notebook.uri),
            ]);
            sinon.assert.calledOnce(confirmation);
            sinon.assert.notCalled(errors); sinon.assert.notCalled(kernels);
            assert.ok(sawRestarting);
            assert.strictEqual(vscode.workspace.notebookDocuments.length, windowCount);
            assert.strictEqual(notebook.cellCount, oldCount + 1);
            assert.strictEqual(notebook.cellAt(oldCell.index), oldCell, 'Existing cells must keep their identity');
            assert.strictEqual(oldCell.document.uri.toString(), oldUri);
            assert.ok(oldCell.document.getText().endsWith('# edited after execution'));
            assert.strictEqual(draft.getText(), 'unsent_draft <- 99');
            assert.ok(displays(oldCell).every(data => data.archived === true && data.generation === original.generation));
            const boundary = notebook.getCells().find(cell => cell.metadata.rNoticeKind === 'restarted');
            assert.ok(boundary && boundary.index > oldCell.index);
            assert.match(boundary.document.getText(), /Continue here in a fresh R process/);
            const config = JSON.parse(fs.readFileSync(path.join(root, original.id, 'config.json'), 'utf8')) as AgentConfig;
            assert.notStrictEqual(config.generation, original.generation);
            assert.strictEqual(notebook.metadata.rGeneration, config.generation);
            assert.deepStrictEqual(config.previousGenerations, [original.generation]);
            assert.notStrictEqual(config.library, path.join(root, 'library'));
            assert.notStrictEqual(config.resources, path.join(process.cwd(), 'R'));
            assert.strictEqual(config.maxAssetBytes, DEFAULT_MAX_ASSET_BYTES);
            assert.ok(fs.existsSync(path.join(config.library, 'sess')));
            const current = (): SessionManifest => JSON.parse(fs.readFileSync(path.join(root, original.id, 'manifest.json'), 'utf8')) as SessionManifest;
            client = new AgentClient(current()); await client.connect({ claim: false });
            assert.notStrictEqual(current().rPid, original.rPid);
            assert.ok(restartController.description?.includes(`PID ${current().rPid ?? ''}`));
            assert.ok(restartController.label.endsWith(' · idle'));
            const afterCode = 'stopifnot(!exists("before_restart")); after_restart <- 7; cat("fresh process")';
            await vscode.commands.executeCommand('r.runSelection', afterCode);
            await until(() => notebook.getCells().some(cell => cell.document.getText() === afterCode && cell.executionSummary?.success === true));
            const index = notebook.cellCount;
            await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: oldCell.index, end: oldCell.index + 1 }], document: notebook.uri });
            await until(() => notebook.cellCount > index && notebook.cellAt(index).executionSummary?.success === true);
            assert.notStrictEqual(notebook.cellAt(index).metadata.rExecutionId, oldId, 'Reruns get fresh execution IDs');
            assert.strictEqual(oldCell.document.uri.toString(), oldUri);
            assert.ok((await client.snapshot()).executions.some(record => record.code === afterCode));
            // Source routing remains bound even when another window becomes active.
            await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
            await vscode.window.showTextDocument(source, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
            await until(() => vscode.window.activeTextEditor?.document === source);
            await vscode.commands.executeCommand('r.runSelection');
            await until(() => notebook.getCells().some(cell => cell.document.getText() === source.getText().trim() && cell.executionSummary?.success === true));
            client.close();
            await vscode.commands.executeCommand('r.interactive.restart', notebook.uri);
            assert.strictEqual(vscode.workspace.notebookDocuments.length, windowCount);
            assert.strictEqual(notebook.getCells().filter(cell => cell.metadata.rNoticeKind === 'restarted').length, 2);
            assert.strictEqual(draft.getText(), 'unsent_draft <- 99');
            client = new AgentClient(current()); await client.connect({ claim: false });
            await vscode.commands.executeCommand('r.interactive.open', current());
            const finalCode = 'stopifnot(!exists("after_restart")); cat("third process")';
            await vscode.commands.executeCommand('r.runSelection', finalCode);
            await until(() => notebook.getCells().some(cell => cell.document.getText() === finalCode && cell.executionSummary?.success === true));
            for (const format of ['rnb', 'ipynb', 'R', 'html']) {
                const destination = vscode.Uri.file(path.join(root, `restarted.${format}`));
                const save = sinon.stub(vscode.window, 'showSaveDialog').resolves(destination);
                const picker = sinon.stub(vscode.window, 'showQuickPick').resolves({ label: format, format } as vscode.QuickPickItem);
                try { await vscode.commands.executeCommand('r.interactive.export', notebook.uri); }
                finally { save.restore(); picker.restore(); }
                const content = fs.readFileSync(destination.fsPath, 'utf8');
                assert.ok(content.includes('before_restart') && content.includes('after_restart') && content.includes('third process'));
                assert.strictEqual((content.match(/R session restarted/g) ?? []).length, 2);
            }
            // Disconnect/reopen reconstructs all three generations from disk in this notebook.
            await vscode.commands.executeCommand('r.interactive.detach', notebook.uri);
            await vscode.commands.executeCommand('r.interactive.open', current());
            assert.strictEqual(vscode.workspace.notebookDocuments.length, windowCount);
            assert.strictEqual(notebook.getCells().filter(cell => cell.metadata.rNoticeKind === 'restarted').length, 2);
            assert.ok(notebook.getCells().some(cell => cell.metadata.rExecutionId === oldId));
            assert.ok(notebook.getCells().some(cell => cell.document.getText() === finalCode));
            assert.strictEqual(draft.getText(), 'unsent_draft <- 99');
            await vscode.commands.executeCommand('r.interactive.clear', notebook.uri);
            assert.ok(!notebook.getCells().some(cell => cell.metadata.rExecutionId === oldId));
            sinon.assert.notCalled(errors);
        } finally {
            confirmation.restore(); errors.restore(); kernels.restore(); change.dispose();
            await vscode.workspace.getConfiguration('r').update('interactive.nodePath', nodePath, vscode.ConfigurationTarget.Global);
            if (!client?.connected) {
                client = new AgentClient(JSON.parse(fs.readFileSync(path.join(root, original.id, 'manifest.json'), 'utf8')) as SessionManifest);
                try { await client.connect(); } catch { client.close(); client = undefined; }
            }
            if (client) {
                await client.request('claim', { force: true });
                await client.request('stop');
                let exited = false;
                const deadline = Date.now() + 10000;
                while (!exited && Date.now() < deadline) {
                    exited = (await client.request<{ status: string }>('heartbeat')).status === 'exited';
                    if (!exited) { await new Promise(resolve => setTimeout(resolve, 50)); }
                }
                if (exited) { await client.request('shutdown'); }
                client.close();
            }
        }
    });
    suite('bulk session management', () => {
        const bulk: SessionManifest[] = [];
        let other: AgentClient;
        let notebook: vscode.NotebookDocument;
        let windowCount: number;
        const start = async (): Promise<SessionManifest> => {
            const id = randomUUID();
            const config: AgentConfig = { id, generation: randomUUID(), label: `Bulk test ${bulk.length}`,
                directory: root, storage: path.join(root, id), library: path.join(root, 'library'),
                rPath: 'R', resources: path.join(process.cwd(), 'R'), provider: 'r', supervision: 'detached',
                plotBackend: 'auto', historyLimit: 50, maxOutputBytes: 1048576, maxJournalBytes: 16777216 };
            const agent = new SessionAgent(config); agents.push(agent);
            const manifest = await agent.start(); bulk.push(manifest);
            await until(() => manifest.status === 'idle');
            return manifest;
        };
        suiteSetup(async () => {
            for (let i = 0; i < 4; i++) { await start(); }
            other = new AgentClient(bulk[2]); await other.connect();
            await vscode.commands.executeCommand('r.interactive.open', bulk[0]);
            const opened = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === bulk[0].id);
            assert.ok(opened); notebook = opened;
            const edit = new vscode.WorkspaceEdit();
            edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(0, [new vscode.NotebookCellData(vscode.NotebookCellKind.Code,
                'bulk_retained <- 42; print(bulk_retained)', 'r')])]);
            await vscode.workspace.applyEdit(edit);
            await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }], document: notebook.uri });
            await until(() => notebook.cellAt(0).executionSummary?.success === true);
            windowCount = vscode.workspace.notebookDocuments.length;
        });
        suiteTeardown(async () => {
            other?.close();
            if (notebook) { await vscode.commands.executeCommand('r.interactive.detach', notebook.uri); }
        });
        test('cancelling the multi-select picker or all-session confirmation leaves every session alive', async () => {
            const picker = sinon.stub(vscode.window, 'showQuickPick').resolves(undefined);
            const confirm = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);
            try {
                await vscode.commands.executeCommand('r.interactive.stopSelected');
                assert.strictEqual(picker.firstCall.args[1]?.canPickMany, true);
                assert.strictEqual((await picker.firstCall.args[0]).length, 4);
                sinon.assert.notCalled(confirm);
                await vscode.commands.executeCommand('r.interactive.stopAll');
                sinon.assert.calledOnce(confirm);
                assert.match(confirm.firstCall.args[0], /Stop 4 R Interactive sessions/);
                const detail = confirm.firstCall.args[1].detail ?? '';
                for (const manifest of bulk) { assert.ok(detail.includes(`${manifest.label} — PID ${manifest.rPid ?? 'starting'}`)); }
                assert.ok(bulk.every(manifest => manifest.status === 'idle'));
                assert.strictEqual(vscode.workspace.notebookDocuments.length, windowCount);
            } finally { picker.restore(); confirm.restore(); }
        });
        test('tree multi-selection deduplicates targets, retains output, and never stops a replacement generation', async () => {
            const stale = { ...bulk[1], generation: randomUUID() };
            const confirm = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);
            confirm.onFirstCall().resolves('Stop 2 Sessions' as unknown as vscode.MessageItem);
            const picker = sinon.stub(vscode.window, 'showQuickPick').resolves(undefined);
            try {
                await vscode.commands.executeCommand('r.interactive.stopSelected', bulk[0], [bulk[0], stale, bulk[0]]);
                sinon.assert.notCalled(picker);
                assert.strictEqual(bulk[0].status, 'exited');
                assert.strictEqual(bulk[1].status, 'idle');
                assert.strictEqual(bulk[2].status, 'idle');
                assert.match(confirm.lastCall.args[0], /Stopped 1 of 2.*1 could not be stopped/);
                await until(() => notebook.getCells().some(cell => cell.metadata.rNoticeKind === 'stopped'));
                assert.ok(notebook.cellAt(0).outputs.some(output => output.items.some(item => Buffer.from(item.data).toString().includes('42'))));
                assert.strictEqual(vscode.workspace.notebookDocuments.length, windowCount);
            } finally { confirm.restore(); picker.restore(); }
        });
        test('picker selection stops unopened sessions and reports other-window control without affecting unselected sessions', async () => {
            const picker = sinon.stub(vscode.window, 'showQuickPick').resolves(bulk.slice(1, 3).map(manifest => ({ label: manifest.label, manifest })) as never);
            const confirm = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);
            confirm.onFirstCall().resolves('Stop 2 Sessions' as unknown as vscode.MessageItem);
            try {
                await vscode.commands.executeCommand('r.interactive.stopSelected');
                const choices = await picker.firstCall.args[0] as (vscode.QuickPickItem & { manifest: SessionManifest })[];
                assert.deepStrictEqual(new Set(choices.map(choice => choice.manifest.id)), new Set(bulk.slice(1).map(manifest => manifest.id)));
                assert.strictEqual(bulk[1].status, 'exited');
                assert.strictEqual(bulk[2].status, 'idle');
                assert.strictEqual(bulk[3].status, 'idle');
                assert.strictEqual((await other.request<{ control: boolean }>('heartbeat')).control, true);
                assert.match(confirm.lastCall.args[0], /Stopped 1 of 2.*1 could not be stopped/);
                const manager = bundleContext().subscriptions.find(item => typeof (item as InteractiveManager).open === 'function') as InteractiveManager;
                assert.ok(!manager.getChildren().some(manifest => manifest.id === bulk[1].id), 'Stopped unopened sessions leave no dead tree link');
                assert.ok(manager.getChildren().some(manifest => manifest.id === bulk[0].id), 'An open stopped transcript stays in the tree');
                assert.strictEqual(vscode.workspace.notebookDocuments.length, windowCount);
            } finally { picker.restore(); confirm.restore(); }
        });
        test('Stop All captures its targets before confirmation, skips other windows, and stops the remaining sessions after control is released', async () => {
            const confirm = sinon.stub(vscode.window, 'showWarningMessage').resolves(undefined);
            confirm.onFirstCall().callsFake(async () => {
                await start(); // A new session created while the confirmation is open was not approved.
                return 'Stop 2 Sessions' as unknown as vscode.MessageItem;
            });
            const info = sinon.stub(vscode.window, 'showInformationMessage').resolves(undefined);
            try {
                await vscode.commands.executeCommand('r.interactive.stopAll');
                assert.strictEqual(bulk[2].status, 'idle');
                assert.strictEqual(bulk[3].status, 'exited');
                assert.strictEqual(bulk[4].status, 'idle');
                assert.match(confirm.lastCall.args[0], /Stopped 1 of 2/);
                await other.request('detach'); other.close();
                confirm.resetBehavior(); confirm.resolves('Stop 2 Sessions' as unknown as vscode.MessageItem);
                await vscode.commands.executeCommand('r.interactive.stopAll');
                assert.ok(bulk.every(manifest => manifest.status === 'exited'));
                assert.match(info.lastCall.args[0], /Stopped 2 of 2/);
                const count = confirm.callCount;
                await vscode.commands.executeCommand('r.interactive.stopAll');
                assert.strictEqual(confirm.callCount, count);
                assert.match(info.lastCall.args[0], /No running R Interactive sessions/);
                assert.strictEqual(vscode.workspace.notebookDocuments.length, windowCount);
            } finally { confirm.restore(); info.restore(); }
        });
    });
    test('exports portable notebook output without transient connection URLs', () => {
        const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'plot(1:3)', 'r');
        cell.executionSummary = { executionOrder: 1, success: true };
        cell.outputs = [new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.json({ kind: 'plot', svg: 'plot.svg', svgData: 'c3Zn', url: 'http://localhost:1234/private-token/plot.svg' }, DISPLAY_MIME),
            vscode.NotebookCellOutputItem.text('<svg/>', 'image/svg+xml'),
        ]), new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout('hello')])];
        const data = new vscode.NotebookData([cell]);
        const serializer = new InteractiveSerializer();
        const saved = serializer.serializeNotebook(data);
        const restored = serializer.deserializeNotebook(saved);
        const custom = restored.cells[0].outputs?.[0].items.find(item => item.mime === DISPLAY_MIME);
        assert.ok(custom);
        const output = JSON.parse(Buffer.from(custom.data).toString()) as Record<string, unknown>;
        assert.strictEqual(output.url, undefined); assert.strictEqual(output.svgData, 'c3Zn');
        assert.strictEqual(output.connected, false);
        const ipynb = JSON.parse(Buffer.from(serializer.exportIpynb(data)).toString()) as {
            nbformat: number; cells: { outputs: { output_type: string; data?: Record<string, unknown>; text?: string }[] }[];
        };
        assert.strictEqual(ipynb.nbformat, 4);
        assert.strictEqual(ipynb.cells[0].outputs[0].data?.['image/svg+xml'], '<svg/>');
        assert.strictEqual(ipynb.cells[0].outputs[1].output_type, 'stream');
        assert.strictEqual(ipynb.cells[0].outputs[1].text, 'hello');
        assert.ok(!JSON.stringify(ipynb).includes('private-token'));
    });

});
