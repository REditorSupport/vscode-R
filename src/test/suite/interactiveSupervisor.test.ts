import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { prepareSupervisor } from '../../interactive/supervisor';
import { launchAgent } from '../../interactive/launcher';
import { AgentConfig } from '../../interactive/protocol';

(process.platform === 'win32' ? suite.skip : suite)('Interactive session supervision', () => {
    let root: string;
    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-supervisor-'));
    });
    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });
    function executable(name: string, script = '#!/bin/sh\nexit 0\n'): string {
        const file = path.join(root, name);
        fs.writeFileSync(file, script, { mode: 0o700 });
        return file;
    }

    test('Linux auto uses an independent process when tmux is missing or not executable', () => {
        const expected = prepareSupervisor('auto', root, 'linux', root);
        assert.strictEqual(expected.kind, 'detached');
        assert.ok('notice' in expected && expected.notice?.includes('tmux is unavailable'));
        fs.mkdirSync(path.join(root, 'tmux'));
        assert.deepStrictEqual(prepareSupervisor('auto', root, 'linux', root), expected);
        fs.rmdirSync(path.join(root, 'tmux'));
        fs.writeFileSync(path.join(root, 'tmux'), 'not executable', { mode: 0o600 });
        assert.deepStrictEqual(prepareSupervisor('auto', root, 'linux', root), expected);
    });

    test('Linux auto prefers executable tmux and resolves relative PATH against the session directory', () => {
        const tmux = executable('tmux');
        assert.deepStrictEqual(prepareSupervisor('auto', root, 'linux', '.'), {
            kind: 'tmux',
            executable: tmux,
        });
        assert.deepStrictEqual(prepareSupervisor('tmux', root, 'darwin', root), {
            kind: 'tmux',
            executable: tmux,
        });
        assert.deepStrictEqual(prepareSupervisor('auto', root, 'darwin', root), {
            kind: 'detached',
        });
        assert.deepStrictEqual(prepareSupervisor('detached', root, 'linux', root), {
            kind: 'detached',
        });
    });

    test('explicit supervisors require their executables and report remote-host recovery instructions', () => {
        for (const kind of ['tmux', 'systemd']) {
            assert.throws(
                () => prepareSupervisor(kind, root, 'linux', root),
                /remote server.*r\.interactive\.supervision.*auto.*detached/,
            );
        }
        const systemd = executable('systemd-run');
        assert.deepStrictEqual(prepareSupervisor('systemd', root, 'linux', root), {
            kind: 'systemd',
            executable: systemd,
        });
        assert.throws(
            () => prepareSupervisor('invalid', root, 'linux', root),
            /Unknown session supervisor.*r\.interactive\.supervision/,
        );
        assert.throws(
            () => prepareSupervisor('auto', root, 'win32', root),
            /requires Linux or macOS/,
        );
    });

    test('missing explicit supervisors fail before creating storage or launching Node', async () => {
        const environment = sinon.stub(process.env, 'PATH').value(root);
        try {
            for (const supervision of ['tmux', 'systemd']) {
                await assert.rejects(
                    launchAgent(
                        {
                            supervision,
                            directory: root,
                            storage: path.join(root, 'session'),
                        } as AgentConfig,
                        'unused-agent',
                        { executable: 'missing-node', electron: false },
                    ),
                    /Cannot find an executable.*r\.interactive\.supervision/,
                );
            }
            assert.deepStrictEqual(fs.readdirSync(root), []);
        } finally {
            environment.restore();
        }
    });

    test('an installed supervisor launch failure reports diagnostics without starting a second agent', async () => {
        const argumentsFile = path.join(root, 'supervisor-arguments');
        executable(
            'tmux',
            `#!/bin/sh\nprintf '%s\\n' "$@" > '${argumentsFile}'\necho "test tmux server failure" >&2\nexit 1\n`,
        );
        executable(
            'systemd-run',
            `#!/bin/sh\nprintf '%s\\n' "$@" > '${argumentsFile}'\necho "test systemd user service failure" >&2\nexit 1\n`,
        );
        const marker = path.join(root, 'unexpected-detached-launch');
        const node = executable(
            'node',
            `#!/bin/sh\nif [ "$1" = "-p" ] && [ "$ELECTRON_RUN_AS_NODE" = 1 ]; then echo 24.0.0; else : > '${marker}'; exit 1; fi\n`,
        );
        const environment = sinon.stub(process.env, 'PATH').value(root);
        try {
            for (const supervision of [
                ...(process.platform === 'linux' ? ['auto'] : []),
                'tmux',
                'systemd',
            ]) {
                const config = {
                    id: supervision,
                    generation: 'test',
                    supervision,
                    directory: root,
                    storage: path.join(root, `session-${supervision}`),
                } as AgentConfig;
                await assert.rejects(
                    launchAgent(config, 'unused-agent', { executable: node, electron: true }),
                    /Could not start.*r\.interactive\.supervision.*test (tmux|systemd).*failure/s,
                );
                // The tmux server/systemd manager can predate VS Code and does
                // not necessarily inherit the environment of this invocation.
                assert.match(
                    fs.readFileSync(argumentsFile, 'utf8'),
                    supervision === 'systemd'
                        ? /--setenv=ELECTRON_RUN_AS_NODE=1/
                        : /ELECTRON_RUN_AS_NODE=1 exec /,
                );
                assert.ok(!fs.existsSync(marker));
                assert.ok(!fs.existsSync(path.join(config.storage, 'manifest.json')));
            }
        } finally {
            environment.restore();
        }
    });
});
