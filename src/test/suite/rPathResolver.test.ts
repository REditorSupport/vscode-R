import * as assert from 'assert';

import {
    createRPathResolverDependencies,
    ExecutableResolution,
    findExecutableOnPath,
    formatRPath,
    resolveBackgroundR,
    resolveConsoleR,
    resolveSystemR,
    RPathResolverDependencies,
    selectWorkspaceFolder,
    substitutePathVariables,
} from '../../rPathResolver';

interface DependencyHarness {
    dependencies: RPathResolverDependencies;
    executableLookups: string[];
    pathChecks: string[];
    getSystemRCalls: () => number;
}

function createDependencies(
    settings: Record<string, string | undefined>,
    executables: Record<string, string> = {},
    existingPaths: readonly string[] = [],
    systemR = '/system/R',
    substituteVariables: (value: string) => string = value => value
): DependencyHarness {
    const executableLookups: string[] = [];
    const pathChecks: string[] = [];
    let systemRCalls = 0;
    return {
        dependencies: {
            getSetting: setting => settings[setting],
            substituteVariables,
            findExecutable: name => {
                executableLookups.push(name);
                return executables[name];
            },
            pathExists: value => {
                pathChecks.push(value);
                return existingPaths.includes(value);
            },
            getSystemR: () => {
                systemRCalls += 1;
                return Promise.resolve(systemR || undefined);
            },
        },
        executableLookups,
        pathChecks,
        getSystemRCalls: () => systemRCalls,
    };
}

suite('R executable resolver', () => {
    test('background precedence is canonical, legacy, then system', async () => {
        const canonical = createDependencies(
            { executablePath: '/canonical/R', 'rpath.linux': '/legacy/R' },
            {},
            ['/canonical/R', '/legacy/R']
        );
        assert.deepStrictEqual(
            await resolveBackgroundR(canonical.dependencies, 'rpath.linux'),
            { path: '/canonical/R', setting: 'executablePath', quote: undefined }
        );
        assert.strictEqual(canonical.getSystemRCalls(), 0);

        const legacy = createDependencies(
            { executablePath: '', 'rpath.linux': 'legacy-R' },
            { 'legacy-R': '/legacy/R' }
        );
        assert.deepStrictEqual(
            await resolveBackgroundR(legacy.dependencies, 'rpath.linux'),
            { path: '/legacy/R', setting: 'rpath.linux', quote: undefined }
        );
        assert.strictEqual(legacy.getSystemRCalls(), 0);

        const system = createDependencies({ executablePath: ' ', 'rpath.linux': '' });
        assert.deepStrictEqual(
            await resolveBackgroundR(system.dependencies, 'rpath.linux'),
            { path: '/system/R' }
        );
        assert.strictEqual(system.getSystemRCalls(), 1);
    });

    test('an invalid explicit background setting does not fall through', async () => {
        const harness = createDependencies(
            { executablePath: 'missing-R', 'rpath.linux': '/legacy/R' },
            {},
            ['/legacy/R']
        );
        assert.deepStrictEqual(
            await resolveBackgroundR(harness.dependencies, 'rpath.linux'),
            { path: undefined, setting: 'executablePath', quote: undefined }
        );
        assert.strictEqual(harness.getSystemRCalls(), 0);
        assert.deepStrictEqual(harness.executableLookups, ['missing-R']);
    });

    test('an invalid explicit legacy background setting does not fall through', async () => {
        const harness = createDependencies({ executablePath: '', 'rpath.linux': '/missing/R' });
        assert.deepStrictEqual(
            await resolveBackgroundR(harness.dependencies, 'rpath.linux'),
            { path: undefined, setting: 'rpath.linux', quote: undefined }
        );
        assert.strictEqual(harness.getSystemRCalls(), 0);
    });

    test('overwrite setting retains highest background precedence', async () => {
        const harness = createDependencies(
            { override: '/override/R', executablePath: '/canonical/R', 'rpath.linux': '/legacy/R' },
            {},
            ['/override/R', '/canonical/R', '/legacy/R']
        );
        assert.deepStrictEqual(
            await resolveBackgroundR(harness.dependencies, 'rpath.linux', 'override'),
            { path: '/override/R', setting: 'override', quote: undefined }
        );
    });

    test('console precedence is canonical, legacy, explicit canonical background, then system', async () => {
        const canonical = createDependencies(
            {
                consolePath: '/canonical/radian',
                'rterm.linux': '/legacy/radian',
                executablePath: '/background/R',
            },
            {},
            ['/canonical/radian', '/legacy/radian', '/background/R']
        );
        assert.deepStrictEqual(
            await resolveConsoleR(canonical.dependencies, 'rterm.linux'),
            { path: '/canonical/radian', setting: 'consolePath', quote: undefined }
        );

        const legacy = createDependencies(
            { consolePath: '', 'rterm.linux': 'legacy-radian', executablePath: '/background/R' },
            { 'legacy-radian': '/legacy/radian' },
            ['/background/R']
        );
        assert.deepStrictEqual(
            await resolveConsoleR(legacy.dependencies, 'rterm.linux'),
            { path: '/legacy/radian', setting: 'rterm.linux', quote: undefined }
        );

        const background = createDependencies(
            { consolePath: '', 'rterm.linux': '', executablePath: '/background/R' },
            {},
            ['/background/R']
        );
        assert.deepStrictEqual(
            await resolveConsoleR(background.dependencies, 'rterm.linux'),
            { path: '/background/R', setting: 'executablePath', quote: undefined }
        );

        const system = createDependencies({ consolePath: '', 'rterm.linux': '', executablePath: '' });
        assert.deepStrictEqual(
            await resolveConsoleR(system.dependencies, 'rterm.linux'),
            { path: '/system/R' }
        );
    });

    test('legacy background setting never feeds console fallback', async () => {
        const harness = createDependencies({
            consolePath: '',
            'rterm.linux': '',
            executablePath: '',
            'rpath.linux': '/legacy/background/R',
        });
        assert.deepStrictEqual(
            await resolveConsoleR(harness.dependencies, 'rterm.linux'),
            { path: '/system/R' }
        );
        assert.strictEqual(harness.getSystemRCalls(), 1);
    });

    test('invalid explicit console choices do not silently fall through', async () => {
        const consoleHarness = createDependencies({
            consolePath: 'missing-console',
            'rterm.linux': '/legacy/radian',
            executablePath: '/background/R',
        }, {}, ['/legacy/radian', '/background/R']);
        assert.deepStrictEqual(
            await resolveConsoleR(consoleHarness.dependencies, 'rterm.linux'),
            { path: undefined, setting: 'consolePath', quote: undefined }
        );
        assert.strictEqual(consoleHarness.getSystemRCalls(), 0);

        const legacyHarness = createDependencies({
            consolePath: '',
            'rterm.linux': '/missing/console',
            executablePath: '/background/R',
        }, {}, ['/background/R']);
        assert.deepStrictEqual(
            await resolveConsoleR(legacyHarness.dependencies, 'rterm.linux'),
            { path: undefined, setting: 'rterm.linux', quote: undefined }
        );
        assert.strictEqual(legacyHarness.getSystemRCalls(), 0);

        const backgroundHarness = createDependencies({
            consolePath: '',
            'rterm.linux': '',
            executablePath: 'missing-background',
        });
        assert.deepStrictEqual(
            await resolveConsoleR(backgroundHarness.dependencies, 'rterm.linux'),
            { path: undefined, setting: 'executablePath', quote: undefined }
        );
        assert.strictEqual(backgroundHarness.getSystemRCalls(), 0);
    });

    test('empty and quoted-empty values are unset', async () => {
        const harness = createDependencies({
            consolePath: '  ',
            'rterm.linux': '\u0027\u0027',
            executablePath: '',
        });
        assert.deepStrictEqual(
            await resolveConsoleR(harness.dependencies, 'rterm.linux'),
            { path: '/system/R' }
        );
        assert.strictEqual(harness.getSystemRCalls(), 1);
    });

    test('bare executable names resolve only through PATH lookup', async () => {
        const harness = createDependencies(
            { executablePath: 'custom-R', 'rpath.linux': '' },
            { 'custom-R': '/tools/custom-R' },
            ['/workspace/custom-R']
        );
        assert.strictEqual(
            (await resolveBackgroundR(harness.dependencies, 'rpath.linux')).path,
            '/tools/custom-R'
        );
        assert.deepStrictEqual(harness.executableLookups, ['custom-R']);
        assert.deepStrictEqual(harness.pathChecks, []);
    });

    test('r.consolePath bare arf resolves to its absolute path on PATH', async () => {
        const harness = createDependencies(
            { consolePath: 'arf', 'rterm.linux': '', executablePath: '' },
            { arf: '/opt/arf/bin/arf' }
        );
        assert.deepStrictEqual(
            await resolveConsoleR(harness.dependencies, 'rterm.linux'),
            { path: '/opt/arf/bin/arf', setting: 'consolePath', quote: undefined }
        );
        assert.deepStrictEqual(harness.executableLookups, ['arf']);
        assert.strictEqual(harness.getSystemRCalls(), 0);
    });

    test('substituted absolute paths resolve without treating them as commands', async () => {
        const harness = createDependencies(
            { executablePath: '${workspaceFolder}/tools/R', 'rpath.linux': '' },
            {},
            ['/workspace/tools/R'],
            '/system/R',
            value => substitutePathVariables(value, { workspaceFolder: '/workspace' })
        );
        assert.strictEqual(
            (await resolveBackgroundR(harness.dependencies, 'rpath.linux')).path,
            '/workspace/tools/R'
        );
        assert.deepStrictEqual(harness.pathChecks, ['/workspace/tools/R']);
        assert.deepStrictEqual(harness.executableLookups, []);
    });

    test('unavailable workspace and file variables remain unresolved without crashing or falling through', async () => {
        const harness = createDependencies(
            { executablePath: '${fileWorkspaceFolder}/R', 'rpath.linux': '/legacy/R' },
            {},
            ['/legacy/R'],
            '/system/R',
            value => substitutePathVariables(value, {})
        );
        assert.deepStrictEqual(
            await resolveBackgroundR(harness.dependencies, 'rpath.linux'),
            { path: undefined, setting: 'executablePath', quote: undefined }
        );
        assert.strictEqual(harness.getSystemRCalls(), 0);
    });

    test('all supported variables are substituted', () => {
        assert.strictEqual(
            substitutePathVariables(
                '${userHome}|${workspaceFolder}|${fileWorkspaceFolder}|${fileDirname}',
                {
                    userHome: '/home/user',
                    workspaceFolder: '/workspace/first',
                    fileWorkspaceFolder: '/workspace/second',
                    fileDirname: '/workspace/second/src',
                }
            ),
            '/home/user|/workspace/first|/workspace/second|/workspace/second/src'
        );
        assert.strictEqual(substitutePathVariables('${workspaceFolder}/R', {}), '${workspaceFolder}/R');
    });

    test('workspace selection supports single-root, multi-root, no file, and no workspace', () => {
        const first = { name: 'first' };
        const second = { name: 'second' };
        assert.strictEqual(selectWorkspaceFolder([first], undefined), first);
        assert.strictEqual(selectWorkspaceFolder([first, second], second), second);
        assert.strictEqual(selectWorkspaceFolder([first, second], undefined), first);
        assert.strictEqual(selectWorkspaceFolder([first, second], second, first), first);
        assert.strictEqual(selectWorkspaceFolder([], undefined), undefined);
        assert.strictEqual(selectWorkspaceFolder(undefined, undefined), undefined);
    });

    test('dependency adapter reads configuration for the requested resource', async () => {
        type Resource = 'workspace-a' | 'workspace-b';
        const settings: Record<Resource | 'default', Record<string, string>> = {
            'workspace-a': { executablePath: '/workspace-a/R' },
            'workspace-b': { executablePath: '/workspace-b/R' },
            default: { executablePath: '/default/R' },
        };
        const existingPaths = new Set(['/workspace-a/R', '/workspace-b/R', '/default/R']);
        const dependencies = (resource?: Resource) => createRPathResolverDependencies({
            resource,
            getConfiguration: requestedResource => ({
                get: <T>(setting: string) => settings[requestedResource ?? 'default'][setting] as T | undefined,
            }),
            substituteVariables: value => value,
            findExecutable: () => undefined,
            pathExists: value => existingPaths.has(value),
            getSystemR: () => Promise.resolve(undefined),
        });

        assert.strictEqual((await resolveBackgroundR(dependencies('workspace-a'), 'rpath.linux')).path, '/workspace-a/R');
        assert.strictEqual((await resolveBackgroundR(dependencies('workspace-b'), 'rpath.linux')).path, '/workspace-b/R');
        assert.strictEqual((await resolveBackgroundR(dependencies(), 'rpath.linux')).path, '/default/R');
    });

    test('dependency adapter substitutes workspaceFolder for the requested resource', async () => {
        type Resource = 'workspace-a' | 'workspace-b';
        const workspaceFolders: Record<Resource | 'default', string> = {
            'workspace-a': '/workspace-a',
            'workspace-b': '/workspace-b',
            default: '/active-workspace',
        };
        const existingPaths = new Set(['/workspace-a/R', '/workspace-b/R', '/active-workspace/R']);
        const dependencies = (resource?: Resource) => createRPathResolverDependencies({
            resource,
            getConfiguration: () => ({
                get: <T>(setting: string) => (setting === 'executablePath' ? '${workspaceFolder}/R' : undefined) as T | undefined,
            }),
            substituteVariables: (value, requestedResource) => substitutePathVariables(value, {
                workspaceFolder: workspaceFolders[requestedResource ?? 'default'],
            }),
            findExecutable: () => undefined,
            pathExists: value => existingPaths.has(value),
            getSystemR: () => Promise.resolve(undefined),
        });

        assert.strictEqual((await resolveBackgroundR(dependencies('workspace-a'), 'rpath.linux')).path, '/workspace-a/R');
        assert.strictEqual((await resolveBackgroundR(dependencies('workspace-b'), 'rpath.linux')).path, '/workspace-b/R');
        assert.strictEqual((await resolveBackgroundR(dependencies(), 'rpath.linux')).path, '/active-workspace/R');
    });

    test('quoted configured values are resolved and formatting preserves getRpath quote behavior', async () => {
        const doubleQuoted = createDependencies(
            { executablePath: '"/R path/bin/R"', 'rpath.linux': '' },
            {},
            ['/R path/bin/R']
        );
        const doubleResolution = await resolveBackgroundR(doubleQuoted.dependencies, 'rpath.linux');
        assert.strictEqual(doubleResolution.path, '/R path/bin/R');
        assert.strictEqual(formatRPath(doubleResolution, false, 'linux'), '/R path/bin/R');
        assert.strictEqual(formatRPath(doubleResolution, true, 'linux'), '"/R path/bin/R"');

        const singleResolution: ExecutableResolution = { path: '/R path/bin/R', quote: `'` };
        assert.strictEqual(formatRPath(singleResolution, true, 'linux'), `'/R path/bin/R'`);
        assert.strictEqual(formatRPath(singleResolution, true, 'win32'), '"/R path/bin/R"');
        assert.strictEqual(formatRPath({ path: '/R path/bin/R' }, true, 'linux'), '"/R path/bin/R"');
    });

    test('console resolution returns an unquoted executable path', async () => {
        const harness = createDependencies(
            { consolePath: `'/R console/radian'`, 'rterm.linux': '', executablePath: '' },
            {},
            ['/R console/radian']
        );
        assert.strictEqual(
            (await resolveConsoleR(harness.dependencies, 'rterm.linux')).path,
            '/R console/radian'
        );
    });
});

suite('system R resolver', () => {
    test('PATH lookup handles Unix and Windows executable names', () => {
        const windowsPath = String.raw`C:\first;D:\second`;
        const windowsR = String.raw`D:\second\R.exe`;
        const windowsRDirectory = String.raw`C:\R`;
        const windowsRWithExtension = String.raw`C:\R\R.exe`;

        assert.strictEqual(
            findExecutableOnPath('R', 'linux', '/first:/second', value => value === '/second/R'),
            '/second/R'
        );
        assert.strictEqual(
            findExecutableOnPath('R', 'win32', windowsPath, value => value === windowsR),
            windowsR
        );
        assert.strictEqual(
            findExecutableOnPath('R.exe', 'win32', windowsRDirectory, value => value === windowsRWithExtension),
            windowsRWithExtension
        );
    });

    test('PATH wins over the Windows registry', async () => {
        const pathR = String.raw`C:\PATH\R.exe`;
        let registryCalls = 0;
        assert.strictEqual(await resolveSystemR({
            platform: 'win32',
            findExecutable: () => pathR,
            getWindowsInstallPath: () => {
                registryCalls += 1;
                return Promise.resolve(String.raw`C:\Registry\R`);
            },
        }), pathR);
        assert.strictEqual(registryCalls, 0);
    });

    test(String.raw`Windows registry InstallPath supplies bin\R.exe after PATH misses`, async () => {
        assert.strictEqual(await resolveSystemR({
            platform: 'win32',
            findExecutable: () => undefined,
            getWindowsInstallPath: () => Promise.resolve(String.raw`C:\Program Files\R\R-4.5.0`),
        }), String.raw`C:\Program Files\R\R-4.5.0\bin\R.exe`);
    });

    test('non-Windows systems do not query the registry', async () => {
        let registryCalls = 0;
        assert.strictEqual(await resolveSystemR({
            platform: 'linux',
            findExecutable: () => undefined,
            getWindowsInstallPath: () => {
                registryCalls += 1;
                return Promise.resolve('/registry/R');
            },
        }), undefined);
        assert.strictEqual(registryCalls, 0);
    });
});
