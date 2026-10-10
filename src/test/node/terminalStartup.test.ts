import * as assert from 'node:assert/strict';
import {
    assessTerminalStartup,
    parseTerminalStartupRecord,
} from '../../terminalStartup';

suite('terminal startup sidecar', () => {
    const token = '0123456789abcdef0123456789abcdef';
    const attempt = 'abcdefghijklmnop';
    const endpoint = '/tmp/vscode-r-session.sock';

    function record(status: string, pid = 1234, attemptId = attempt, target = endpoint): string {
        return `vscode-r-terminal-startup-v1\n${token}\n${attemptId}\n${pid}\n${target}\n${status}\n`;
    }

    test('parses the bounded six-line record and accepts CRLF', () => {
        const parsed = parseTerminalStartupRecord(record('ready').replace(/\n/g, '\r\n'), token);
        assert.deepStrictEqual(parsed, { token, attemptId: attempt, pid: 1234, endpoint, status: 'ready' });
    });

    test('rejects malformed, oversized, and foreign records', () => {
        for (const input of [
            record('ready').slice(0, -1),
            record('ready').replace(token, 'f'.repeat(32)),
            record('done'),
            record('ready', 0),
            `${record('ready')}${'x'.repeat(513)}`,
        ]) {
            assert.strictEqual(parseTerminalStartupRecord(input, token), undefined);
        }
    });

    test('cancels a wait when its observed attempt changes', () => {
        const pending = parseTerminalStartupRecord(record('pending'), token);
        const nextAttemptReady = parseTerminalStartupRecord(record('ready', 1234, 'qrstuvwxyzABCDEF'), token);
        assert.deepStrictEqual(assessTerminalStartup(undefined, pending, undefined, undefined), {
            observation: 'pending', attemptId: attempt, readyForOwner: false,
        });
        assert.deepStrictEqual(assessTerminalStartup(attempt, nextAttemptReady, '1234', endpoint), {
            observation: 'attempt-changed', attemptId: 'qrstuvwxyzABCDEF', readyForOwner: false,
        });
        assert.deepStrictEqual(assessTerminalStartup(undefined, nextAttemptReady, '1234', endpoint), {
            observation: 'ready', attemptId: 'qrstuvwxyzABCDEF', readyForOwner: true,
        });
        assert.deepStrictEqual(assessTerminalStartup(attempt, undefined, '1234', endpoint), {
            observation: 'unknown', attemptId: attempt, readyForOwner: false,
        });
    });

    test('requires the sidecar R pid to match the attached owner', () => {
        const parsed = parseTerminalStartupRecord(record('ready'), token);
        assert.ok(parsed);
        assert.strictEqual(assessTerminalStartup(undefined, parsed, '1234', endpoint).readyForOwner, true);
        assert.strictEqual(assessTerminalStartup(undefined, parsed, '1235', endpoint).readyForOwner, false);
        assert.strictEqual(assessTerminalStartup(undefined, parsed, '1234', '/tmp/another.sock').readyForOwner, false);
        assert.strictEqual(assessTerminalStartup(undefined, parsed, undefined, endpoint).readyForOwner, false);
    });
});
