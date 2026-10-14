const fs = require('node:fs');
const path = require('node:path');

function parseVersion(version) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
        throw new Error(`Expected a numeric major.minor.patch version, got ${version}`);
    }
    const parts = version.split('.').map(Number);
    if (parts.some(part => !Number.isSafeInteger(part) || part > 0xffffffff)) {
        throw new Error(`Version component exceeds uint32: ${version}`);
    }
    return parts;
}

function prereleaseVersion(version, date) {
    const [major, minor] = parseVersion(version);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
        || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
        throw new Error(`Expected a UTC date in YYYY-MM-DD format, got ${date}`);
    }
    // Keep an explicitly selected odd series (e.g. 3.999 before 4.0).
    const result = `${major}.${minor % 2 === 0 ? minor + 1 : minor}.${date.replaceAll('-', '')}`;
    parseVersion(result);
    return result;
}

function checkStableVersion(version, tag) {
    const [, minor] = parseVersion(version);
    if (minor % 2 !== 0) {
        throw new Error('Stable releases must use an even minor version');
    }
    if (tag !== `v${version}`) {
        throw new Error(`Release tag ${tag} does not match package.json version ${version}`);
    }
}

function rewriteVersion(manifestPath, date) {
    const source = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(source);
    const version = prereleaseVersion(manifest.version, date);
    // Change only the top-level version, preserving the manifest's formatting.
    manifest.version = version;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return version;
}

module.exports = { parseVersion, prereleaseVersion, checkStableVersion, rewriteVersion };
if (require.main === module) {
    const [command, value] = process.argv.slice(2);
    const manifestPath = path.join(__dirname, '..', '..', 'package.json');
    if (command === 'prerelease') {
        console.log(rewriteVersion(manifestPath, value));
    } else if (command === 'check-stable') {
        checkStableVersion(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version, value);
    } else {
        throw new Error('Usage: node .github/scripts/extension-version.js <prerelease YYYY-MM-DD|check-stable vX.Y.Z>');
    }
}
