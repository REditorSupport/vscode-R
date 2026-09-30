import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { SessionAgent } from '../../interactive/agent';
import { AgentClient } from '../../interactive/client';
import { InteractiveSerializer, DISPLAY_MIME } from '../../interactive/notebook';
import { AgentConfig, SessionManifest, DEFAULT_MAX_ASSET_BYTES } from '../../interactive/protocol';
import { AssetStorageStats, exportedAssetName, readAsset } from '../../interactive/assets';

(process.platform === 'win32' ? suite.skip : suite)('Interactive VS Code integration', function () {
    this.timeout(60000);
    let root: string;
    const sourceDirectories: string[] = [];
    let previousRProfile: string | undefined;
    let previousStorage: string | undefined;
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
            await vscode.commands.executeCommand('r.interactive.reuseCell', notebook.cellAt(0));
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
    test('exports large compressed plots to portable notebooks and ordinary SVG report assets', async function () {
        if (!manifests[0].capabilities.jgd) { this.skip(); }
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.metadata.rSessionId === manifests[0].id);
        assert.ok(notebook);
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        const saved = sinon.stub(vscode.window, 'showSaveDialog');
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
        } finally { errors.restore(); saved.restore(); info.restore(); }
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
    test('restart upgrades the private R runtime and asset quota while preserving the session identity', async () => {
        const original = manifests[1];
        const confirmation = sinon.stub(vscode.window, 'showWarningMessage').resolves('Restart Session' as unknown as vscode.MessageItem);
        const errors = sinon.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        let client: AgentClient | undefined;
        try {
            await vscode.commands.executeCommand('r.interactive.restart', original);
            sinon.assert.notCalled(errors);
            const config = JSON.parse(fs.readFileSync(path.join(root, original.id, 'config.json'), 'utf8')) as AgentConfig;
            assert.notStrictEqual(config.generation, original.generation);
            assert.notStrictEqual(config.library, path.join(root, 'library'));
            assert.notStrictEqual(config.resources, path.join(process.cwd(), 'R'));
            assert.strictEqual(config.maxAssetBytes, DEFAULT_MAX_ASSET_BYTES);
            assert.ok(fs.existsSync(path.join(config.library, 'sess')));
            const current = JSON.parse(fs.readFileSync(path.join(root, original.id, 'manifest.json'), 'utf8')) as SessionManifest;
            assert.strictEqual(current.id, original.id);
            client = new AgentClient(current); await client.connect();
            await client.request('claim', { force: true });
            const id = randomUUID();
            await client.request('submit', { submission: { id, code: 'cat("restarted with new runtime")' } });
            let complete = false;
            const deadline = Date.now() + 10000;
            while (!complete && Date.now() < deadline) {
                complete = (await client.request<{ state: string }>('execution', { id })).state === 'success';
                if (!complete) { await new Promise(resolve => setTimeout(resolve, 50)); }
            }
            assert.ok(complete);
        } finally {
            confirmation.restore(); errors.restore();
            if (client) {
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
