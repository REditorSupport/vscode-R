import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveArfExecutable } from '../../interactive/arfExecutable';

suite('Interactive arf executable discovery', () => {
    let root: string;
    const name = process.platform === 'win32' ? 'arf.exe' : 'arf';
    setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'r-arf-path-')); });
    teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });
    function binary(directory = root): string {
        fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, name);
        fs.writeFileSync(file, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
        return file;
    }

    test('missing optional arf has no executable, including an invalid custom path', () => {
        assert.strictEqual(resolveArfExecutable('arf', root, root), undefined);
        assert.strictEqual(resolveArfExecutable(path.join(root, 'missing', name), root), undefined);
        binary();
        assert.strictEqual(resolveArfExecutable('./missing/arf', root, root), undefined, 'A custom path must not fall back to PATH');
    });

    test('finds executable files on PATH without running them and pins the absolute path', () => {
        const file = binary(path.join(root, 'bin'));
        assert.strictEqual(resolveArfExecutable('arf', root, path.dirname(file)), file);
        assert.strictEqual(resolveArfExecutable('', root, 'bin'), file);
        assert.strictEqual(resolveArfExecutable('arf', root, path.join(root, 'missing') + path.delimiter + 'bin'), file);
    });

    test('accepts relative paths, quoted paths and spaces', () => {
        const file = binary(path.join(root, 'with spaces'));
        for (const command of [file, `"${file}"`, `'${file}'`, `./with spaces/${name}`]) {
            assert.strictEqual(resolveArfExecutable(command, root, ''), file);
        }
    });

    test('expands home paths on this host', () => {
        const file = binary();
        assert.strictEqual(resolveArfExecutable(`~/${path.relative(os.homedir(), file)}`, root, ''), file);
    });

    test('rejects directories and files without execute permission and skips unusable PATH entries', function () {
        fs.mkdirSync(path.join(root, name));
        assert.strictEqual(resolveArfExecutable(path.join(root, name), root), undefined);
        const file = binary(path.join(root, 'bin'));
        assert.strictEqual(resolveArfExecutable('arf', root, root + path.delimiter + path.dirname(file)), file);
        if (process.platform === 'win32') { return; }
        fs.chmodSync(file, 0o600);
        assert.strictEqual(resolveArfExecutable(file, root), undefined);
        assert.strictEqual(resolveArfExecutable('arf', root, path.dirname(file)), undefined);
    });

    test('accepts executable symlinks and rejects broken links', function () {
        if (process.platform === 'win32') { this.skip(); }
        const file = binary(path.join(root, 'real'));
        const link = path.join(root, 'arf'); fs.symlinkSync(file, link);
        assert.strictEqual(resolveArfExecutable('arf', root, root), link);
        fs.unlinkSync(file);
        assert.strictEqual(resolveArfExecutable('arf', root, root), undefined);
    });
});
