import { defineConfig } from '@vscode/test-cli';
import interactiveTestOptions from './scripts/interactive-test-options.cjs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const common = {
	mocha: {
		ui: 'tdd',
		color: true,
		timeout: 20000,
		...interactiveTestOptions
	},
	desktop: {
		installExtensions: ['REditorSupport.r-syntax']
	}
};

const configurations = [
	{ ...common, label: 'extension', files: 'out/test/suite/**/*.test.js' }
];

if (process.env.VSCR_TEST_SKIP_SESS_TASKS !== '1') {
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

	configurations.push({
		...common,
		label: 'sess-install-tasks',
		files: 'out/test/integration/**/*.test.js',
		workspaceFolder: workspaceFile,
		launchArgs: ['--disable-workspace-trust'],
		// Let each project's .Rprofile select its library, even when the caller
		// runs from an existing managed R terminal with R_PROFILE_USER set.
		env: { R_PROFILE_USER: undefined, VSCODE_R_SESS_PKG_PATH: undefined, VSCODE_R_SESS_REPO: undefined }
	});
}

export default defineConfig(configurations);
