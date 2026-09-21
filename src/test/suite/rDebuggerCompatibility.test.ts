import * as assert from 'assert';
import * as vscode from 'vscode';

import {
    registersLegacyRPathSetting,
    rDebuggerCompatibilityWarningKey,
    showRDebuggerCompatibilityWarningOnce,
} from '../../rDebuggerCompatibility';

suite('R Debugger compatibility warning', () => {
    test('detects legacy settings in an object configuration', () => {
        assert.strictEqual(registersLegacyRPathSetting({
            contributes: {
                configuration: {
                    properties: { 'r.rpath.windows': { type: 'string' } },
                },
            },
        }), true);
    });

    test('detects legacy settings in an array configuration', () => {
        assert.strictEqual(registersLegacyRPathSetting({
            contributes: {
                configuration: [
                    { properties: { unrelated: { type: 'string' } } },
                    { properties: { 'r.rpath.mac': { type: 'string' } } },
                ],
            },
        }), true);
    });

    test('ignores malformed configuration and unrelated or inherited properties', () => {
        const inheritedProperties = Object.create({ 'r.rpath.linux': { type: 'string' } }) as Record<string, unknown>;
        assert.strictEqual(registersLegacyRPathSetting(undefined), false);
        assert.strictEqual(registersLegacyRPathSetting({ contributes: { configuration: null } }), false);
        assert.strictEqual(registersLegacyRPathSetting({
            contributes: { configuration: { properties: { 'r.rpath': { type: 'string' } } } },
        }), false);
        assert.strictEqual(registersLegacyRPathSetting({
            contributes: { configuration: { properties: inheritedProperties } },
        }), false);
    });

    test('shows the warning once and stores its versioned global state key', async () => {
        let warningWasShown: boolean | undefined;
        const globalState = {
            get: <T>(key: string) => key === rDebuggerCompatibilityWarningKey ? warningWasShown as T | undefined : undefined,
            update: (key: string, value: unknown) => Promise.resolve().then(() => {
                assert.strictEqual(key, rDebuggerCompatibilityWarningKey);
                warningWasShown = value as boolean;
            }),
        } as unknown as vscode.Memento;
        const messages: string[] = [];
        const packageJSON = {
            contributes: { configuration: { properties: { 'r.rpath.linux': { type: 'string' } } } },
        };

        assert.strictEqual(await showRDebuggerCompatibilityWarningOnce(globalState, packageJSON, message => messages.push(message)), true);
        assert.strictEqual(await showRDebuggerCompatibilityWarningOnce(globalState, packageJSON, message => messages.push(message)), false);
        assert.strictEqual(warningWasShown, true);
        assert.strictEqual(messages.length, 1);
        assert.match(messages[0], /keep.*in sync with `r\.executablePath`/);
    });

    test('does not store state or warn when the extension has no legacy setting', async () => {
        let updateCalled = false;
        const globalState = {
            get: () => undefined,
            update: () => Promise.resolve().then(() => { updateCalled = true; }),
        } as unknown as vscode.Memento;
        let warningCalled = false;

        assert.strictEqual(await showRDebuggerCompatibilityWarningOnce(
            globalState,
            { contributes: { configuration: { properties: { 'r.executablePath': { type: 'string' } } } } },
            () => { warningCalled = true; }
        ), false);
        assert.strictEqual(updateCalled, false);
        assert.strictEqual(warningCalled, false);
    });
});
