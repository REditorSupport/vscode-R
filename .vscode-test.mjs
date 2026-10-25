import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// A separate window keeps the real multi-folder task tests isolated from mocks.
const taskRoot = mkdtempSync(path.join(tmpdir(), 'vscode-r sess tasks '));
for (const project of ['project A', 'project B']) {
	mkdirSync(path.join(taskRoot, project));
}
const workspaceFile = path.join(taskRoot, 'projects.code-workspace');
writeFileSync(workspaceFile, JSON.stringify({
	folders: [{ path: 'project A' }, { path: 'project B' }]
}));
process.on('exit', () => rmSync(taskRoot, { recursive: true, force: true }));

const common = {
	mocha: {
		ui: 'tdd',
		color: true,
		timeout: 20000
	}
};

// Keep mock/provider tests independent of R language-server startup. Editor
// command tests also need a fresh window after fixtures create terminals and
// webviews. The real Interactive suite has its own window with the LSP enabled.
function testProfile(name, lspEnabled) {
	const directory = path.resolve('.vscode-test/user-data', name);
	mkdirSync(path.join(directory, 'User'), { recursive: true });
	writeFileSync(path.join(directory, 'User/settings.json'), JSON.stringify({ 'r.lsp.enabled': lspEnabled }));
	return ['--user-data-dir', directory];
}

export default defineConfig([
	{
		...common,
		label: 'provider-tests',
		files: 'out/test/suite/**/!(interactiveEditor|interactiveInputFeatures|completionMiddleware).test.js',
		mocha: { ...common.mocha, require: './out/test/common/extensionSetup.js' },
		launchArgs: testProfile('provider-tests', false)
	},
	{
		...common,
		label: 'editor-command-tests',
		files: [
			'out/test/suite/interactiveInputFeatures.test.js',
			'out/test/suite/completionMiddleware.test.js'
		],
		mocha: { ...common.mocha, require: './out/test/common/extensionSetup.js' },
		launchArgs: testProfile('editor-command-tests', false)
	},
	{
		...common,
		label: 'interactive-integration',
		files: 'out/test/suite/interactiveEditor.test.js',
		launchArgs: testProfile('interactive-tests', true)
	},
	{
		...common,
		label: 'sess-install-tasks',
		files: 'out/test/integration/**/*.test.js',
		workspaceFolder: workspaceFile,
		launchArgs: ['--disable-workspace-trust'],
		// Let each project's .Rprofile select its library, even when the caller
		// runs from an existing managed R terminal with R_PROFILE_USER set.
		env: { R_PROFILE_USER: undefined, VSCODE_R_SESS_PKG_PATH: undefined, VSCODE_R_SESS_REPO: undefined }
	}
]);
