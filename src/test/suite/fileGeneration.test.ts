import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as util from '../../util';
import { createGitignore } from '../../rGitignore';
import { generateCppProperties } from '../../cppProperties';
import { createLintrConfig } from '../../lintrConfig';
import { mockExtensionContext } from '../common/mockvscode';

suite('Generated file overwrite prompts', () => {
    let sandbox: sinon.SinonSandbox;
    let directory: string;
    setup(() => {
        sandbox = sinon.createSandbox();
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-r-overwrite-'));
        mockExtensionContext(path.resolve(__dirname, '../../..'), sandbox);
        sandbox.stub(util, 'getCurrentWorkspaceFolder').returns({ uri: vscode.Uri.file(directory) } as vscode.WorkspaceFolder);
        sandbox.stub(util, 'getRpath').resolves(undefined);
    });
    teardown(() => {
        sandbox.restore();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    for (const answer of [undefined, 'No']) {
        test(`preserves existing files after ${answer ?? 'dismissal'}`, async () => {
            sandbox.stub(vscode.window, 'showWarningMessage').callsFake(() => Promise.resolve(answer) as unknown as Thenable<never>);
            const ignorePath = path.join(directory, '.gitignore');
            const cppPath = path.join(directory, '.vscode', 'c_cpp_properties.json');
            const lintrPath = path.join(directory, '.lintr');
            fs.mkdirSync(path.dirname(cppPath));
            fs.writeFileSync(ignorePath, 'user ignore rules');
            fs.writeFileSync(cppPath, 'user compiler settings');
            fs.writeFileSync(lintrPath, 'user lint settings');
            await createGitignore();
            await generateCppProperties();
            await createLintrConfig();
            // Flush any callback-based filesystem writes before inspecting the files.
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.strictEqual(fs.readFileSync(ignorePath, 'utf8'), 'user ignore rules');
            assert.strictEqual(fs.readFileSync(cppPath, 'utf8'), 'user compiler settings');
            assert.strictEqual(fs.readFileSync(lintrPath, 'utf8'), 'user lint settings');
        });
    }

    test('failed compiler configuration generation preserves the existing file', async () => {
        sandbox.stub(vscode.window, 'showWarningMessage').callsFake(() => Promise.resolve('Yes') as unknown as Thenable<never>);
        const cppPath = path.join(directory, '.vscode', 'c_cpp_properties.json');
        fs.mkdirSync(path.dirname(cppPath));
        fs.writeFileSync(cppPath, 'user compiler settings');
        await generateCppProperties();
        assert.strictEqual(fs.readFileSync(cppPath, 'utf8'), 'user compiler settings');
    });
});
