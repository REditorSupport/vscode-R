import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as extension from '../../extension';
import * as rTerminal from '../../rTerminal';
import * as selection from '../../selection';
import * as util from '../../util';
import { previewDataframe, previewEnvironment } from '../../preview';

suite('CSV previews', () => {
    let sandbox: sinon.SinonSandbox;
    let directory: string;
    let temporary: string;
    let activate: sinon.SinonStub;
    let execute: sinon.SinonStub;
    let run: sinon.SinonStub;
    let error: sinon.SinonStub;
    setup(() => {
        sandbox = sinon.createSandbox();
        directory = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-r-preview-'"));
        temporary = path.join(directory, 'preview');
        fs.mkdirSync(temporary);
        sandbox.stub(extension, 'enableSessionWatcher').value(false);
        sandbox
            .stub(util, 'config')
            .returns({ get: () => false } as unknown as vscode.WorkspaceConfiguration);
        sandbox
            .stub(util, 'getCurrentWorkspaceFolder')
            .returns({ uri: vscode.Uri.file(directory) } as vscode.WorkspaceFolder);
        sandbox.stub(util, 'createTempDir').returns(temporary);
        sandbox.stub(selection, 'getWordOrSelection').returns('iris');
        activate = sandbox.stub().resolves();
        sandbox
            .stub(vscode.extensions, 'getExtension')
            .returns({ isActive: false, activate } as unknown as vscode.Extension<unknown>);
        execute = sandbox.stub(vscode.commands, 'executeCommand').resolves();
        run = sandbox.stub(rTerminal, 'runTextInTerm').resolves(true);
        error = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    });
    teardown(() => {
        sandbox.restore();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    for (const [name, preview] of [
        ['iris', previewDataframe],
        ['environment', previewEnvironment],
    ] as const) {
        test(`${name} preview waits for completed output and activates an installed viewer`, async () => {
            const csv = path.join(temporary, `${name}.csv`);
            const open = sandbox
                .stub(vscode.workspace, 'openTextDocument')
                .resolves({ uri: vscode.Uri.file(csv) } as vscode.TextDocument);
            let polls = 0;
            sandbox.stub(util, 'delay').callsFake(() => {
                polls++;
                sinon.assert.notCalled(open);
                fs.writeFileSync(csv, polls === 1 ? 'partial,' : 'complete,output');
                if (polls === 2) {
                    fs.writeFileSync(`${csv}.ready`, '');
                }
                return Promise.resolve();
            });
            await preview();
            assert.strictEqual(polls, 2);
            sinon.assert.calledOnce(activate);
            sinon.assert.calledOnce(open);
            sinon.assert.calledWith(execute, 'csv.preview', vscode.Uri.file(csv));
            sinon.assert.notCalled(error);
            const code = String(run.firstCall.args[0]);
            assert.ok(code.includes(util.ToRStringLiteral(csv, '"')));
            assert.ok(code.includes('base::file.create('));
            assert.strictEqual(fs.existsSync(temporary), false);
        });
    }

    test('a stalled R writer times out and removes its temporary files', async () => {
        const now = sandbox.stub(Date, 'now').returns(0);
        sandbox.stub(util, 'delay').callsFake(() => {
            now.returns(30000);
            return Promise.resolve();
        });
        const open = sandbox.stub(vscode.workspace, 'openTextDocument');
        await previewDataframe();
        sinon.assert.calledOnce(error);
        assert.match(String(error.firstCall.args[0]), /within 30 seconds/);
        sinon.assert.notCalled(open);
        assert.strictEqual(fs.existsSync(temporary), false);
    });

    test('a cancelled terminal submission does not wait for CSV output', async () => {
        run.resolves(false);
        const delay = sandbox.stub(util, 'delay');
        const open = sandbox.stub(vscode.workspace, 'openTextDocument');
        await previewDataframe();
        sinon.assert.notCalled(delay);
        sinon.assert.notCalled(open);
        sinon.assert.notCalled(error);
        assert.strictEqual(fs.existsSync(temporary), false);
    });

    test('preview failure is awaited and still cleans up output', async () => {
        fs.writeFileSync(path.join(temporary, 'iris.csv'), 'a,b');
        fs.writeFileSync(path.join(temporary, 'iris.csv.ready'), '');
        sandbox.stub(vscode.workspace, 'openTextDocument').rejects(new Error('cannot open CSV'));
        await previewDataframe();
        sinon.assert.calledOnce(error);
        assert.match(String(error.firstCall.args[0]), /cannot open CSV/);
        assert.strictEqual(fs.existsSync(temporary), false);
    });

    test('the R environment export includes global objects in a path with quotes', async () => {
        const csv = path.join(temporary, 'environment.csv');
        run.callsFake(async (code: string) => {
            await promisify(execFile)('Rscript', [
                '--vanilla',
                '-e',
                `csv_preview_object <- 42; ${code}`,
            ]);
            return true;
        });
        let contents = '';
        sandbox.stub(vscode.workspace, 'openTextDocument').callsFake(() => {
            contents = fs.readFileSync(csv, 'utf8');
            return Promise.resolve({ uri: vscode.Uri.file(csv) } as vscode.TextDocument);
        });
        await previewEnvironment();
        assert.match(contents, /csv_preview_object/);
        assert.match(contents, /numeric/);
        sinon.assert.notCalled(error);
        assert.strictEqual(fs.existsSync(temporary), false);
    });
});
