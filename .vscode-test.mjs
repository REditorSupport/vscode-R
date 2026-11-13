import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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
	const directory = fileURLToPath(new URL(`.vscode-test/user-data/${name}/`, import.meta.url));
	mkdirSync(path.join(directory, 'User'), { recursive: true });
	writeFileSync(path.join(directory, 'User/settings.json'), JSON.stringify({ 'r.lsp.enabled': lspEnabled }));
	// Unattended runs can be occluded by another app. Keep browser paint and
	// resize callbacks active so webview assertions observe actual loading.
	return [
		'--user-data-dir', directory,
		'--disable-renderer-backgrounding',
		'--disable-background-timer-throttling',
		'--disable-backgrounding-occluded-windows'
	];
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
		label: 'plot-lifecycle',
		files: 'out/test/plot/**/*.test.js',
		mocha: { ...common.mocha, require: './out/test/common/extensionSetup.js' },
		launchArgs: testProfile('plots', false)
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
	}
]);
