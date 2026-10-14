import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as util from '../../util';
import { RMarkdownManager, KnitWorkingDirectory } from '../../rmarkdown/manager';
import { RMarkdownKnitManager } from '../../rmarkdown/knit';
import { mockExtensionContext } from '../common/mockvscode';

class KnitHarness extends RMarkdownManager {
    directory(kind: KnitWorkingDirectory, file: string) { return this.getKnitDir(kind, file); }
    knit(callback: (text: string) => boolean) {
        this.rPath = 'R';
        return this.knitDocument({ workingDirectory: os.tmpdir(), filePath: '/test.Rmd',
            fileName: 'test.Rmd', scriptArgs: {}, scriptPath: '/knit.R', callback });
    }
}

suite('R Markdown execution', () => {
    let sandbox: sinon.SinonSandbox;
    setup(() => {
        sandbox = sinon.createSandbox();
        mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
    });
    teardown(() => sandbox.restore());

    test('working directories preserve literal quotes for spawn and environment values', () => {
        const directory = path.join(os.tmpdir(), `project's "report"`);
        const manager = new KnitHarness();
        assert.strictEqual(manager.directory(KnitWorkingDirectory.documentDirectory, path.join(directory, 'test.Rmd')), directory);
        const workspaceUri = vscode.Uri.file(directory);
        sandbox.stub(vscode.workspace, 'getWorkspaceFolder').returns({ uri: workspaceUri } as vscode.WorkspaceFolder);
        // VS Code normalizes Windows drive-letter casing in URI filesystem paths.
        assert.strictEqual(manager.directory(KnitWorkingDirectory.workspaceRoot, '/test.Rmd'), workspaceUri.fsPath);
    });

    function mockChild() {
        const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(), stderr: new EventEmitter(), dispose: sandbox.stub()
        }) as unknown as util.DisposableProcess;
        sandbox.stub(util, 'spawn').returns(child);
        return child;
    }

    test('knitting rejects an asynchronous spawn failure', async () => {
        const child = mockChild();
        const result = new KnitHarness().knit(() => false);
        child.emit('error', new Error('ENOENT'));
        child.emit('close', -2, null);
        const settled = await Promise.race([
            result.then(() => 'resolved', () => 'rejected'),
            new Promise<string>(resolve => setTimeout(resolve, 100))
        ]);
        assert.strictEqual(settled, 'rejected');
    });

    test('knitting recognizes a completion marker fragmented across UTF-8 chunks', async () => {
        const child = mockChild();
        let output = '';
        const result = new KnitHarness().knit(text => {
            const match = /<<<vsc>>>(.*?)<<<vsc>>>/s.exec(text);
            if (!match) { return false; }
            output = match[1];
            return true;
        });
        const bytes = Buffer.from('<<<vsc>>>/tmp/你好.html<<<vsc>>>');
        child.stdout.emit('data', bytes.subarray(0, 16));
        child.stdout.emit('data', bytes.subarray(16, 22));
        child.stdout.emit('data', bytes.subarray(22));
        child.emit('close', 0, null);
        const settled = await Promise.race([
            result.then(() => 'resolved', () => 'rejected'),
            new Promise<string>(resolve => setTimeout(resolve, 100))
        ]);
        assert.strictEqual(settled, 'resolved');
        assert.strictEqual(output, '/tmp/你好.html');
    });

    test('successful exit without the expected output marker rejects instead of hanging', async () => {
        const child = mockChild();
        const result = new KnitHarness().knit(() => false);
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        const settled = await Promise.race([
            result.then(() => 'resolved', () => 'rejected'),
            new Promise<string>(resolve => setTimeout(resolve, 100))
        ]);
        assert.strictEqual(settled, 'rejected');
    });

    test('knit commands preserve R literals in filenames and custom functions', async () => {
        sandbox.stub(util, 'config').returns({ get: () => 'rmarkdown::render' } as unknown as vscode.WorkspaceConfiguration);
        const manager = new RMarkdownKnitManager() as unknown as {
            getKnitCommand(params: { knit?: string; site: string }, file: string, format?: string): Promise<string>
        };
        const file = util.ToRStringLiteral(`/tmp/it's "report".Rmd`, '"');
        assert.strictEqual(await manager.getKnitCommand({ site: '' }, file), `rmarkdown::render(${file})`);
        const knit = 'function(input, ...) rmarkdown::render(input, params = list(label = "a\'b"), ...)';
        assert.strictEqual(await manager.getKnitCommand({ site: '', knit }, file, 'html_document'),
            `(${knit})(${file}, output_format = "html_document")`);
    });

    test('non-object YAML frontmatter cannot leave knitting permanently busy', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-knit-'));
        try {
            const file = path.join(directory, 'test.Rmd');
            fs.writeFileSync(file, '---\n# comments only\n---\n');
            sandbox.stub(util, 'config').returns({
                get: (key: string) => key === 'rmarkdown.knit.useBackgroundProcess' ? true : undefined
            } as unknown as vscode.WorkspaceConfiguration);
            sandbox.stub(vscode.window, 'activeTextEditor').value({
                document: { uri: vscode.Uri.file(file), fileName: file, isUntitled: false, isDirty: false }
            });
            const manager = new RMarkdownKnitManager() as unknown as {
                knitRmd(echo: boolean): Promise<void>;
                renderDocument: (literal: string, file: string, name: string, params: unknown) => Promise<void>;
                getYamlFrontmatter(file: string): unknown;
            };
            assert.deepStrictEqual(manager.getYamlFrontmatter(file), {});
            const render = sandbox.stub(manager, 'renderDocument').rejects(new Error('transient failure'));
            await assert.rejects(manager.knitRmd(false), /transient failure/);
            render.resolves();
            await manager.knitRmd(false);
            sinon.assert.calledTwice(render);
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
});
