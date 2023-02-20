import vscode = require('vscode');
import sinon = require('sinon');
import path = require('path');
import assert = require('assert');

import * as exec from '../../executables/service';
import { ExecutableStatusItem } from '../../executables/ui';
import { mockExtensionContext } from '../common';

const extension_root: string = path.join(__dirname, '..', '..', '..');

suite('Language status item', () => {
    let sandbox: sinon.SinonSandbox;
    setup(() => {
        sandbox = sinon.createSandbox();
    });
    teardown(() => {
        sandbox.restore();
    });

    test('text', () => {
        mockExtensionContext(extension_root, sandbox);
        let executableValue: exec.ExecutableType | undefined = undefined;
        const statusItem = new ExecutableStatusItem({
            get activeExecutable() {
                return executableValue;
            }
        } as unknown as exec.RExecutableService);
        assert.strictEqual(
            statusItem.text,
            '$(warning) Select R executable'
        );

        executableValue = {
            get tooltip(): string {
                return `R 4.0 64-bit`;
            },
            rVersion: '4.0'
        } as exec.ExecutableType;
        statusItem.refresh();
        assert.strictEqual(
            statusItem.text,
            '4.0'
        );
        statusItem.dispose();
    });

    test('loading indicator', async () => {
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
});