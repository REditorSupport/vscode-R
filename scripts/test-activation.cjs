// Run after `pnpm run compile`. Every case gets a fresh extension host and
// profile; this runner never calls extension.activate() or extensionSetup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repository = path.resolve(__dirname, '..');
const cases = [
    'no-folder', 'non-r', 'non-r-interactive', 'language-r', 'language-rmd',
    'workspace', 'command', 'terminal-profile', 'task', 'r-notebook',
    'interactive-create', 'interactive-restore',
    'interactive-background-create', 'interactive-background-restore',
    'terminal-persistent-reload',
];
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function clearElectronNodeMode(environment) {
    for (const key of Object.keys(environment)) {
        if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') { delete environment[key]; }
    }
}
exports.clearElectronNodeMode = clearElectronNodeMode;

async function until(predicate, message) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, message);
        await pause(50);
    }
}

async function within(promise, message) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), 20000);
            }),
        ]);
    } finally { clearTimeout(timer); }
}

exports.run = async (api) => {
    const vscode = api?.extensions ? api : require('vscode');
    const testCase = process.env.VSCR_ACTIVATION_CASE;
    const root = process.env.VSCR_ACTIVATION_ROOT;
    const extension = vscode.extensions.getExtension('REditorSupport.r');
    let terminalReload;
    assert.ok(extension, 'The development extension must be available');
    // Give delayed startup activation and workspace searches time to run. The
    // normal suite's forced global activation would hide this regression.
    await pause(3000);

    if (testCase === 'workspace') {
        await until(() => extension.isActive, 'R workspace marker did not activate the extension');
    } else if (testCase === 'interactive-restore') {
        await until(() => extension.isActive, 'Restored R Interactive input did not activate R');
        const input = vscode.workspace.textDocuments.find((document) =>
            document.uri.scheme === 'vscode-interactive-input' && document.languageId === 'r');
        assert.ok(input, 'The empty R Interactive input must retain its language after reopening');
        assert.equal(input.getText(), '');
        assert.ok(!vscode.workspace.textDocuments.some((document) =>
            ['file', 'untitled'].includes(document.uri.scheme) && document.languageId === 'r'),
        'Restoration must activate without a separate R source document');
    } else {
        // VS Code may resolve configured R tasks during startup. That workspace
        // is already R-related; verify its actual provider below either way.
        if (testCase !== 'task') {
            assert.equal(extension.isActive, false, `${testCase}: R activated before an R trigger`);
        }
        switch (testCase) {
            case 'no-folder':
                assert.equal(vscode.workspace.workspaceFolders, undefined);
                break;
            case 'non-r': {
                const document = await vscode.workspace.openTextDocument(
                    vscode.Uri.file(path.join(root, 'workspace', 'index.js')));
                await vscode.window.showTextDocument(document);
                await pause(2000);
                assert.equal(extension.isActive, false, 'JavaScript editing activated R');
                break;
            }
            case 'language-r':
            case 'language-rmd': {
                const language = testCase.slice('language-'.length);
                const document = await vscode.workspace.openTextDocument({ language, content: '' });
                await vscode.window.showTextDocument(document);
                await until(() => extension.isActive, `${language} document did not activate R`);
                break;
            }
            case 'command':
                // A command that does not itself open an R document proves the
                // contributed command's activation route works independently.
                await within(vscode.commands.executeCommand('r.browser.refresh'), 'R command timed out');
                assert.equal(extension.isActive, true, 'Contributed R command did not activate R');
                break;
            case 'terminal-profile': {
                await within(vscode.commands.executeCommand('workbench.action.terminal.newWithProfile',
                    { config: { extensionIdentifier: 'REditorSupport.r', id: 'r.terminal-profile', title: 'R Terminal' } }),
                'R Terminal profile timed out');
                await until(() => extension.isActive, 'R Terminal profile did not activate R');
                await until(() => vscode.window.terminals.length > 0, 'R Terminal was not created');
                vscode.window.terminals.forEach((terminal) => terminal.dispose());
                break;
            }
            case 'terminal-persistent-reload': {
                const phaseFile = path.join(root, 'terminal-reload-state.json');
                const reloading = fs.existsSync(phaseFile);
                if (!reloading) {
                    await within(vscode.commands.executeCommand('workbench.action.terminal.newWithProfile',
                        { config: { extensionIdentifier: 'REditorSupport.r', id: 'r.terminal-profile', title: 'R Terminal' } }),
                    'Persistent R Terminal creation timed out');
                }
                await until(() => vscode.window.terminals.length > 0, 'Persistent R Terminal was not restored');
                const terminal = vscode.window.terminals[0];
                const terminalPid = await within(terminal.processId, 'Restored terminal PID was not available');
                const stateFile = path.join(root, reloading ? 'terminal-after' : 'terminal-before');
                const rFile = JSON.stringify(stateFile.replace(/\\/g, '/'));
                const rTemporary = JSON.stringify(`${stateFile}.pending`.replace(/\\/g, '/'));
                terminal.sendText(`${reloading ? '' : '.vscode_r_activation_marker <- 42; '}` +
                    `writeLines(c(as.character(Sys.getpid()), get('.session_id', asNamespace('sess'))(), ` +
                    `as.character(.vscode_r_activation_marker)), ${rTemporary}); ` +
                    `stopifnot(file.rename(${rTemporary}, ${rFile}))`);
                await until(() => fs.existsSync(stateFile), 'R terminal did not report its retained state');
                const [pid, sessionId, marker] = fs.readFileSync(stateFile, 'utf8').trim().split(/\r?\n/);
                assert.equal(marker, '42', 'Window reload must retain the R workspace');
                if (!reloading) {
                    await until(() => extension.exports.session.getSessionReference(sessionId),
                        'Initial R terminal sess attachment did not complete');
                    fs.writeFileSync(phaseFile, JSON.stringify({ terminalPid, pid, sessionId,
                        connectionId: extension.exports.session.getSessionReference(sessionId).connectionId }));
                    return 'reload';
                }
                const previous = JSON.parse(fs.readFileSync(phaseFile, 'utf8'));
                assert.equal(terminalPid, previous.terminalPid, 'Window reload must retain the terminal process');
                assert.equal(pid, previous.pid, 'Window reload must retain the same R process');
                assert.equal(sessionId, previous.sessionId, 'The retained R process must keep its sess identity');
                assert.equal(extension.isActive, false, 'Restored terminal waits for explicit R activation');
                assert.ok(!vscode.workspace.textDocuments.some((document) => ['r', 'rmd'].includes(document.languageId)),
                    'The restored terminal must not rely on an R source document');
                terminal.show();
                await until(() => vscode.window.activeTerminal === terminal, 'Restored R terminal did not receive focus');
                await within(vscode.commands.executeCommand('r.activateRSession'), 'Restored R terminal activation timed out');
                await until(() => extension.exports.session.getSessionReference(sessionId),
                    'Explicit activation did not reconnect the retained R terminal');
                assert.notEqual(extension.exports.session.getSessionReference(sessionId).connectionId, previous.connectionId);
                terminalReload = { terminalPid, rPid: Number(pid), retainedWorkspace: true,
                    inactiveAfterReload: true, reconnected: true };
                terminal.dispose();
                break;
            }
            case 'task': {
                const tasks = await within(vscode.tasks.fetchTasks({ type: 'R' }), 'R task resolution timed out');
                assert.ok(tasks.some((task) => task.name === 'Activation task' && task.execution),
                    'The contributed R task must be resolved without opening R source');
                assert.equal(extension.isActive, true, 'R task resolution did not activate R');
                break;
            }
            case 'r-notebook': {
                const notebook = await within(vscode.workspace.openNotebookDocument(
                    vscode.Uri.file(path.join(root, 'notebook.rnb'))), 'R notebook opening timed out');
                await vscode.window.showNotebookDocument(notebook);
                assert.equal(notebook.notebookType, 'r-interactive');
                assert.equal(extension.isActive, true, 'R notebook did not activate R');
                break;
            }
            case 'interactive-background-restore': {
                const uri = vscode.Uri.parse(fs.readFileSync(path.join(root, 'interactive-uri'), 'utf8'));
                assert.ok(vscode.window.tabGroups.all.some((group) =>
                    group.tabs.some((tab) => tab.label === 'Activation test')),
                'The original background Interactive tab must have been restored');
                await within(vscode.commands.executeCommand('interactive.open',
                    { preserveFocus: false }, uri), 'Restored background Interactive tab timed out');
                await until(() => extension.isActive, 'Opening restored background R input did not activate R');
                assert.ok(vscode.workspace.textDocuments.some((document) =>
                    document.uri.scheme === 'vscode-interactive-input' && document.languageId === 'r'),
                'Background Interactive input must retain R language');
                break;
            }
            case 'non-r-interactive':
            case 'interactive-create':
            case 'interactive-background-create': {
                const opened = await within(vscode.commands.executeCommand('interactive.open',
                    { preserveFocus: false }, undefined, undefined, 'Activation test'),
                'Native Interactive window timed out');
                assert.ok(opened?.inputUri, 'Native Interactive must expose its input URI');
                let input = await vscode.workspace.openTextDocument(opened.inputUri);
                input = await vscode.languages.setTextDocumentLanguage(input, 'python');
                await pause(2000);
                assert.equal(extension.isActive, false, 'Python native Interactive activated R');
                if (testCase !== 'non-r-interactive') {
                    const controller = vscode.notebooks.createNotebookController(
                        'activation-r', 'interactive', 'Activation R');
                    controller.supportedLanguages = ['r'];
                    await vscode.commands.executeCommand('notebook.selectKernel', {
                        id: controller.id, extension: 'vscode-r-tests.activation-fixture',
                        notebookEditor: { notebookUri: opened.notebookUri },
                    });
                    input = await vscode.languages.setTextDocumentLanguage(input, 'r');
                    await vscode.commands.executeCommand('interactive.input.focus');
                    await until(() => extension.isActive, 'R native Interactive input did not activate R');
                    assert.equal(input.getText(), '');
                    const notebook = await vscode.workspace.openNotebookDocument(opened.notebookUri);
                    assert.equal(notebook.cellCount, 0, 'Restore fixture must have no R transcript cells');
                    fs.writeFileSync(path.join(root, 'interactive-uri'), opened.notebookUri.toString());
                    if (testCase === 'interactive-background-create') {
                        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(
                            vscode.Uri.file(path.join(root, 'workspace', 'index.js'))));
                    }
                    // Keep this native tab open. The next fully exited editor
                    // reuses only this profile and restores the empty R input.
                    await pause(1000);
                }
                break;
            }
            default:
                throw new Error(`Unknown activation case: ${testCase}`);
        }
    }
    const result = { case: testCase, vscode: vscode.version, active: extension.isActive, ...terminalReload };
    fs.writeFileSync(path.join(root, `${testCase}.json`), JSON.stringify(result));
    console.log('Activation regression:', JSON.stringify(result));
};

async function main() {
    // Electron on Windows enters Node mode even when this variable is empty.
    // runTests merges process.env itself, so remove it from our environment
    // before either the test runner or ordinary restore windows inherit it.
    clearElectronNodeMode(process.env);
    const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron');
    const { spawnSync } = require('node:child_process');
    const executable = process.env.VSCR_ACTIVATION_VSCODE || await downloadAndUnzipVSCode();
    const selected = process.env.VSCR_ACTIVATION_CASES?.split(',') || cases;
    selected.forEach((testCase) => assert.ok(cases.includes(testCase), `Unknown case: ${testCase}`));
    for (const prefix of ['interactive-', 'interactive-background-']) {
        if (selected.includes(`${prefix}restore`)) {
            assert.ok(selected.includes(`${prefix}create`), 'Restore requires its create stage in the same run');
            assert.ok(selected.indexOf(`${prefix}create`) < selected.indexOf(`${prefix}restore`));
        }
    }
    // macOS's long per-user TMPDIR can exceed the Unix socket path limit.
    const root = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'r-act-'));
    const extensions = path.join(root, 'extensions');
    fs.mkdirSync(extensions);
    // Extension test mode uses in-memory editor storage. Restoration needs
    // ordinary development windows and a helper that exits after assertions.
    const helper = path.join(root, 'helper');
    fs.mkdirSync(helper);
    fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({
        name: 'activation-fixture', publisher: 'vscode-r-tests', version: '1.0.0',
        engines: { vscode: '^1.101.0' }, activationEvents: ['onStartupFinished'], main: 'index.cjs',
    }));
    fs.writeFileSync(path.join(helper, 'index.cjs'), `
const vscode = require('vscode');
exports.activate = async () => {
    let reload = false;
    try { reload = await require(${JSON.stringify(__filename)}).run(vscode) === 'reload'; }
    catch (error) { require('node:fs').writeFileSync(require('node:path').join(process.env.VSCR_ACTIVATION_ROOT,
        process.env.VSCR_ACTIVATION_CASE + '.error'), error.stack || String(error)); }
    finally { await vscode.commands.executeCommand(reload ? 'workbench.action.reloadWindow' : 'workbench.action.quit'); }
};
`);
    // Reuse the cached syntax dependency when available; clean CI installs only
    // that dependency into this run's isolated extension directory.
    const cached = path.join(repository, '.vscode-test', 'extensions');
    const syntax = fs.existsSync(cached) && fs.readdirSync(cached).find((name) =>
        name.startsWith('reditorsupport.r-syntax-'));
    if (syntax) {
        fs.cpSync(path.join(cached, syntax), path.join(extensions, syntax), { recursive: true });
    } else {
        const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
        const installed = spawnSync(cli, [...args, '--user-data-dir', path.join(root, 'install-profile'), '--extensions-dir', extensions,
            '--install-extension', 'REditorSupport.r-syntax'],
        { stdio: 'inherit', shell: process.platform === 'win32' });
        assert.equal(installed.status, 0, 'Could not install the R syntax dependency');
    }
    let success = false;
    try {
        const reports = [];
        for (const testCase of selected) {
            const persistentTerminal = testCase === 'terminal-persistent-reload';
            const name = testCase.startsWith('interactive-background-') ? 'restore-background'
                : testCase.startsWith('interactive-') ? 'restore' : testCase;
            const caseRoot = path.join(root, name);
            const workspace = path.join(caseRoot, 'workspace');
            const profile = path.join(caseRoot, 'profile');
            fs.mkdirSync(workspace, { recursive: true });
            fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
            fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
                'r.lsp.enabled': false, 'r.sessionWatcher': persistentTerminal, 'r.plot.backend': 'native',
                'r.interactive.restore': false, 'r.interactive.storagePath': path.join(caseRoot, 'sessions'),
                'update.mode': 'none', 'extensions.autoUpdate': false, 'workbench.startupEditor': 'none',
                'window.restoreWindows': 'all', 'terminal.integrated.enablePersistentSessions': persistentTerminal,
                ...(persistentTerminal ? { 'r.session.emulateRStudioAPI': false,
                    'r.consoleArgs': ['--no-save', '--no-restore', '--no-site-file'] } : {}),
            }));
            fs.writeFileSync(path.join(workspace, 'index.js'), 'const unrelated = true;\n');
            if (testCase === 'workspace') {
                fs.mkdirSync(path.join(workspace, 'nested'), { recursive: true });
                fs.writeFileSync(path.join(workspace, 'nested', 'sample.R'), '1 + 1\n');
            }
            if (testCase === 'task') {
                fs.mkdirSync(path.join(workspace, '.vscode'));
                fs.writeFileSync(path.join(workspace, '.vscode', 'tasks.json'), JSON.stringify({
                    version: '2.0.0', tasks: [{ type: 'R', label: 'Activation task', code: ['1 + 1'] }],
                }));
            }
            if (testCase === 'r-notebook') {
                fs.writeFileSync(path.join(caseRoot, 'notebook.rnb'), JSON.stringify({ version: 1, metadata: {}, cells: [] }));
            }
            const env = { VSCR_ACTIVATION_CASE: testCase, VSCR_ACTIVATION_ROOT: caseRoot };
            if (persistentTerminal) {
                const library = path.join(caseRoot, 'r-library');
                const librariesFile = path.join(caseRoot, 'r-library-paths');
                const emptyProfile = path.join(caseRoot, 'empty-profile');
                fs.mkdirSync(library);
                fs.writeFileSync(emptyProfile, '');
                const rString = (value) => JSON.stringify(value.replace(/\\/g, '/'));
                const setup = spawnSync('Rscript', ['--vanilla', '-e',
                    `writeLines(.libPaths(), ${rString(librariesFile)}); ` +
                    `install.packages(${rString(path.join(repository, 'dist', 'resources', 'sess'))}, ` +
                    `lib=${rString(library)}, repos=NULL, type='source')`],
                { encoding: 'utf8', timeout: 300000 });
                assert.equal(setup.status, 0, `Could not prepare isolated terminal sess: ${setup.stderr}`);
                env.R_LIBS_USER = [library, ...fs.readFileSync(librariesFile, 'utf8').trim().split(/\r?\n/)].join(path.delimiter);
                env.R_PROFILE_USER = emptyProfile;
            }
            const launchArgs = [
                    ...(testCase === 'no-folder' ? [] : [workspace]),
                    '--user-data-dir', profile, '--extensions-dir', extensions,
                    '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
            ];
            const log = fs.createWriteStream(path.join(caseRoot, `${testCase}.log`));
            try {
                if (testCase.startsWith('interactive-') || persistentTerminal) {
                    await new Promise((resolve, reject) => {
                        const child = require('node:child_process').spawn(executable, [...launchArgs,
                            '--no-sandbox', '--disable-gpu-sandbox', '--skip-welcome', '--skip-release-notes', '--disable-updates',
                            '--disable-workspace-trust', `--extensionDevelopmentPath=${repository}`,
                            `--extensionDevelopmentPath=${helper}`], { env: { ...process.env, ...env } });
                        const timer = setTimeout(() => { child.kill(); reject(new Error('Restore window timed out')); },
                            persistentTerminal ? 90000 : 45000);
                        child.stdout.on('data', (data) => log.write(data));
                        child.stderr.on('data', (data) => log.write(data));
                        child.once('error', (error) => { clearTimeout(timer); reject(error); });
                        child.once('close', (code) => {
                            clearTimeout(timer);
                            if (code === 0) { resolve(); }
                            else { reject(new Error(`Restore window exited ${code}`)); }
                        });
                    });
                    const errorFile = path.join(caseRoot, `${testCase}.error`);
                    assert.ok(!fs.existsSync(errorFile), fs.existsSync(errorFile) && fs.readFileSync(errorFile, 'utf8'));
                } else {
                    await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: repository,
                        extensionTestsPath: __filename, extensionTestsEnv: env, launchArgs, stdout: log, stderr: log });
                }
            } finally { await new Promise((resolve) => log.end(resolve)); }
            reports.push(JSON.parse(fs.readFileSync(path.join(caseRoot, `${testCase}.json`), 'utf8')));
        }
        console.log(JSON.stringify(reports, null, 2));
        success = true;
    } finally {
        if (success) { fs.rmSync(root, { recursive: true, force: true }); }
        else {
            const artifacts = path.join(repository, '.vscode-test', 'activation');
            fs.mkdirSync(artifacts, { recursive: true });
            for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
                if (!directory.isDirectory()) { continue; }
                for (const file of fs.readdirSync(path.join(root, directory.name))) {
                    if (file.endsWith('.log')) {
                        fs.copyFileSync(path.join(root, directory.name, file),
                            path.join(artifacts, `${directory.name}-${file}`));
                    }
                }
            }
            console.error('Retained activation test profiles:', root, 'and logs:', artifacts);
        }
    }
}

if (require.main === module) {
    main().catch((error) => { console.error(error); process.exitCode = 1; });
}
