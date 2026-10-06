const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prereleaseVersion, checkStableVersion, rewriteVersion } = require('./extension-version');

test('daily versions are independent of stable patch releases', () => {
    for (const version of ['3.0.1', '3.0.2', '3.0.99']) {
        assert.equal(prereleaseVersion(version, '2026-10-06'), '3.1.20261006');
    }
    assert.equal(prereleaseVersion('3.2.0', '2026-10-07'), '3.3.20261007');
    assert.equal(prereleaseVersion('3.999.0', '2026-10-07'), '3.999.20261007');
    assert.equal(prereleaseVersion('4.0.0', '2026-10-08'), '4.1.20261008');
});

test('versions increase across days, years, stable releases and majors', () => {
    const versions = ['3.0.2', prereleaseVersion('3.0.2', '2026-12-31'),
        prereleaseVersion('3.0.2', '2027-01-01'), '3.2.0',
        prereleaseVersion('3.999.0', '2027-01-02'), '4.0.0'];
    const compare = (a, b) => {
        const aa = a.split('.').map(Number);
        const bb = b.split('.').map(Number);
        return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2];
    };
    assert.deepEqual([...versions].sort(compare), versions);
});

test('stable releases require even minors and matching tags', () => {
    checkStableVersion('3.0.2', 'v3.0.2');
    checkStableVersion('3.2.0', 'v3.2.0');
    checkStableVersion('4.0.0', 'v4.0.0');
    for (const [version, tag] of [['3.1.0', 'v3.1.0'], ['3.0.2', 'v3.0.1'],
        ['3.0.2-rc.1', 'v3.0.2-rc.1'], ['3.00.2', 'v3.00.2']]) {
        assert.throws(() => checkStableVersion(version, tag));
    }
});

test('invalid dates and non-Marketplace versions fail closed', () => {
    for (const date of ['2026-02-30', '2026-13-01', '20261006', '']) {
        assert.throws(() => prereleaseVersion('3.0.1', date));
    }
    for (const version of ['3.0.1-rc.0', '3.0', '3.0.4294967296']) {
        assert.throws(() => prereleaseVersion(version, '2026-10-06'));
    }
});

test('rewrite changes only the version and is repeatable for retries', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-version-'));
    try {
        const file = path.join(directory, 'package.json');
        const original = { name: 'r', version: '3.0.1', contributes: { commands: [] } };
        fs.writeFileSync(file, `${JSON.stringify(original, null, 2)}\n`);
        assert.equal(rewriteVersion(file, '2026-10-06'), '3.1.20261006');
        assert.equal(rewriteVersion(file, '2026-10-06'), '3.1.20261006');
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...original, version: '3.1.20261006' });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
