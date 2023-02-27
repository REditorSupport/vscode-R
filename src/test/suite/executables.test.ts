import vscode = require('vscode');
import sinon = require('sinon');
import path = require('path');
import assert = require('assert');


import * as ext from '../../extension';
import * as exec from '../../executables/service';
import { ExecutableStatusItem } from '../../executables/ui';
import { mockExtensionContext } from '../common';
import { RExecutablePathStorage } from '../../executables/service/pathStorage';
import { DummyMemento } from '../../util';
import { LocatorServiceFactory } from '../../executables/service/locator';
import { VirtualRExecutable } from '../../executables/service';

const extension_root: string = path.join(__dirname, '..', '..', '..');

suite('R Executable Service', () => {
    let sandbox: sinon.SinonSandbox;
    setup(() => {
        sandbox = sinon.createSandbox();
    });
    teardown(() => {
        sandbox.restore();
    });

    test('status item text', () => {
        mockExtensionContext(extension_root, sandbox);
        let executableValue: exec.RExecutableType | undefined = undefined;
        const statusItem = new ExecutableStatusItem({
            get activeExecutable() {
                return executableValue;
            }
        } as unknown as exec.RExecutableService);
        assert.strictEqual(statusItem.text, '$(warning) Select R executable');
        executableValue = {
            get tooltip(): string {
                return `R 4.0 64-bit`;
            },
            rVersion: '4.0'
        } as exec.RExecutableType;
        statusItem.refresh();
        assert.strictEqual(statusItem.text, '4.0');
        statusItem.dispose();
    });

    test('status item loading indicator', async () => {
        mockExtensionContext(extension_root, sandbox);
        const dummyPromise: Promise<void> = new Promise(() => {
            //
        });
        const statusItem = new ExecutableStatusItem({
            get activeExecutable() {
                return undefined;
            }
        } as unknown as exec.RExecutableService);

        void statusItem.makeBusy(dummyPromise);
        assert.strictEqual(statusItem.busy, true);

        await statusItem.makeBusy(Promise.resolve());
        assert.strictEqual(statusItem.busy, false);
        assert.strictEqual(statusItem.severity, vscode.LanguageStatusSeverity.Warning);
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
        assert.strictEqual(pathStorage.getExecutablePath('/working/1'), '/bin/1');

        const pathStorage2 = new RExecutablePathStorage();
        assert.strictEqual(pathStorage2.getExecutablePath('/working/1'), '/bin/1');
    });

    test('executable locator', async () => {
        const locator = LocatorServiceFactory.getLocator();
        await locator.refreshPaths();
        assert(locator.executablePaths.length > 0);
    });
});
