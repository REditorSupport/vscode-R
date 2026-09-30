import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { SessionAgent } from '../../interactive/agent';
import { AgentClient } from '../../interactive/client';
import { InteractiveSerializer, DISPLAY_MIME } from '../../interactive/notebook';
import { SessionManifest } from '../../interactive/protocol';

(process.platform === 'win32' ? suite.skip : suite)('Interactive VS Code integration', function () {
    this.timeout(60000);
    let root: string;
    let previousRProfile: string | undefined;
    let agents: SessionAgent[];
    let manifests: SessionManifest[];
    suiteSetup(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-interactive-editor-'));
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
            const agent = new SessionAgent({ id, generation: randomUUID(), label: `Editor test ${i}`,
                directory: root, storage: path.join(root, id), library: path.join(root, 'library'),
                rPath: 'R', resources: path.join(process.cwd(), 'R'), provider: 'r', supervision: 'test',
                plotBackend: 'auto', historyLimit: 50, maxOutputBytes: 1048576, maxJournalBytes: 16777216 });
            agents.push(agent); manifests.push(await agent.start());
        }
    });
    suiteTeardown(async () => {
        if (previousRProfile === undefined) { delete process.env.R_PROFILE_USER; }
        else { process.env.R_PROFILE_USER = previousRProfile; }
        await vscode.commands.executeCommand('r.interactive.detach');
        agents?.forEach(agent => agent.close());
        await new Promise(resolve => setTimeout(resolve, 200));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const until = async (predicate: () => boolean): Promise<void> => {
        const deadline = Date.now() + 20000;
        while (!predicate()) {
            if (Date.now() > deadline) { throw new Error('Timed out waiting for notebook execution'); }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    };
    test('opens native Interactive without Jupyter and executes through its R kernel', async () => {
        await vscode.commands.executeCommand('r.interactive.open', manifests[0]);
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
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
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
