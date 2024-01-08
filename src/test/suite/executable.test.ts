import * as sinon from 'sinon';
import * as path from 'path';
import * as assert from 'assert';


import * as ext from '../../extension';
import * as exec from '../../executables';
import { ExecutableStatusItem } from '../../executables/ui';
import { mockExtensionContext } from '../common';
import { RExecutablePathStorage } from '../../executables/service/pathStorage';
import { DummyMemento } from '../../util';
import { IRunVirtualBinary, RExecutableManager, isCondaExecutable, setupVirtualAwareProcessArguments } from '../../executables';
import { RExecutable, RExecutableService } from '../../executables/service';

const extension_root: string = path.join(__dirname, '..', '..', '..');

suite('Language Status Item', () => {
    let sandbox: sinon.SinonSandbox;
    setup(() => {
        sandbox = sinon.createSandbox();
    });
    teardown(() => {
        sandbox.restore();
    });

    test('text', () => {
        mockExtensionContext(extension_root, sandbox);
        let executableValue: exec.RExecutableType | undefined = undefined;
        const statusItem = new ExecutableStatusItem({
            get activeExecutable() {
                return executableValue;
            }
        } as unknown as RExecutableService);
        assert.strictEqual(
            statusItem.text,
            '$(warning) Select R executable'
        );

        executableValue = {
            get tooltip(): string {
                return `R 4.0 64-bit`;
            },
            rVersion: '4.0'
        } as exec.RExecutableType;
        statusItem.refresh();
        assert.strictEqual(
            statusItem.text,
            '4.0'
        );
        statusItem.dispose();
    });
});

suite('Executable Path Storage', () => {
    let sandbox: sinon.SinonSandbox;
    setup(() => {
        sandbox = sinon.createSandbox();
    });
    teardown(() => {
        sandbox.restore();
    });
    test('path storage + retrieval', () => {
        const mockExtensionContext = {
            environmentVariableCollection: sandbox.stub(),
            extension: sandbox.stub(),
            extensionMode: sandbox.stub(),
            extensionPath: sandbox.stub(),
            extensionUri: sandbox.stub(),
            globalState: new DummyMemento(),
            globalStorageUri: sandbox.stub(),
            logUri: sandbox.stub(),
            secrets: sandbox.stub(),
            storageUri: sandbox.stub(),
            subscriptions: [],
            workspaceState: {
                get: sinon.stub(),
                update: sinon.stub()
            },
            asAbsolutePath: (relativePath: string) => {
                return path.join(extension_root, relativePath);
            }
        };
        sandbox.stub(ext, 'extensionContext').value(mockExtensionContext);
        const pathStorage = new RExecutablePathStorage();
        pathStorage.setExecutablePath('/working/1', '/bin/1');
        assert.strictEqual(
            pathStorage.getExecutablePath('/working/1'),
            '/bin/1'
        );

        const pathStorage2 = new RExecutablePathStorage();
        assert.strictEqual(
            pathStorage2.getExecutablePath('/working/1'),
            '/bin/1'
        );
    });
});

suite('Virtuals', () => {
    let sandbox: sinon.SinonSandbox;
    setup(() => {
        sandbox = sinon.createSandbox();
    });
    teardown(() => {
        sandbox.restore();
    });
    test('virtual aware args', () => {
        let args: IRunVirtualBinary;
        const rArgs = ['--vanilla'];

        const realExecutable = new RExecutable('/dummy/path/R');
        args = setupVirtualAwareProcessArguments(realExecutable, false, rArgs);
        assert.deepEqual(args, {
            args: [
                '--vanilla'
            ],
            cmd: '/dummy/path/R'
        });

        const virtualExecutable = new exec.CondaVirtualRExecutable('/dummy/conda/path/R');
        args = setupVirtualAwareProcessArguments(virtualExecutable, false, rArgs);
        assert.deepEqual(args, {
            args: [
                'run',
                '-n',
                '',
                '/dummy/conda/path/R',
                '--vanilla'
            ],
            cmd: 'conda'
        });
    });
});
