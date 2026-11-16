const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { clearElectronNodeMode } = require('./test-activation.cjs');

function childEnvironment(environment) {
    const child = spawnSync(process.execPath, ['-e', `
        const flags = Object.keys(process.env).filter(key => key.toUpperCase() === 'ELECTRON_RUN_AS_NODE');
        process.stdout.write(JSON.stringify({ flags, marker: process.env.VSCR_ACTIVATION_MARKER }));
    `], { env: environment, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
}

test('an empty Electron Node-mode flag is still present in a spawned process', () => {
    const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '' };
    assert.equal(childEnvironment(environment).flags.length, 1);
});

test('activation launches remove inherited Electron Node mode and preserve other settings', () => {
    for (const value of ['', '1']) {
        const environment = { ...process.env, ELECTRON_RUN_AS_NODE: value,
            electron_run_as_node: value, Electron_Run_As_Node: value, VSCR_ACTIVATION_MARKER: 'preserved' };
        clearElectronNodeMode(environment);
        assert.deepEqual(childEnvironment(environment), { flags: [], marker: 'preserved' });
    }
});
