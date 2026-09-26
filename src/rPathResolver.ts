import * as path from 'path';
import { ConfigurationReader, getMigratedSetting } from './configuration';

export const rExecutablePathSetting = 'executablePath';
export const rConsolePathSetting = 'consolePath';

export interface PathVariables {
    userHome?: string;
    workspaceFolder?: string;
    fileWorkspaceFolder?: string;
    fileDirname?: string;
}

export interface ExecutableResolution {
    path?: string;
    setting?: string;
    quote?: '"' | '\'';
}

export interface RPathResolverDependencies {
    getSetting: (setting: string) => string | undefined;
    inspectSetting?: ConfigurationReader<string>['inspect'];
    substituteVariables: (value: string) => string;
    findExecutable: (name: string) => string | undefined;
    pathExists: (value: string) => boolean;
    getSystemR: () => Promise<string | undefined>;
}

export interface RPathResolverAdapterOptions<Resource> {
    resource?: Resource;
    getConfiguration: (resource?: Resource) => ConfigurationReader<string>;
    substituteVariables: (value: string, resource?: Resource) => string;
    findExecutable: (name: string) => string | undefined;
    pathExists: (value: string) => boolean;
    getSystemR: () => Promise<string | undefined>;
}

export interface SystemRResolverDependencies {
    platform: NodeJS.Platform;
    findExecutable: (name: string) => string | undefined;
    getWindowsInstallPath: () => Promise<string | undefined>;
}

export function createRPathResolverDependencies<Resource>(
    options: RPathResolverAdapterOptions<Resource>
): RPathResolverDependencies {
    const currentConfig = options.getConfiguration(options.resource);
    return {
        getSetting: setting => currentConfig.get(setting),
        inspectSetting: currentConfig.inspect?.bind(currentConfig),
        substituteVariables: value => options.substituteVariables(value, options.resource),
        findExecutable: options.findExecutable,
        pathExists: options.pathExists,
        getSystemR: options.getSystemR,
    };
}

interface ConfiguredExecutableResolution extends ExecutableResolution {
    setting: string;
}

export function substitutePathVariables(value: string, variables: PathVariables): string {
    const substitutions: ReadonlyArray<[string, string | undefined]> = [
        ['${userHome}', variables.userHome],
        ['${workspaceFolder}', variables.workspaceFolder],
        ['${fileWorkspaceFolder}', variables.fileWorkspaceFolder],
        ['${fileDirname}', variables.fileDirname],
    ];

    let result = value;
    for (const [key, replacement] of substitutions) {
        if (replacement) {
            result = result.replaceAll(key, replacement);
        }
    }
    return result;
}

export function selectWorkspaceFolder<T>(
    workspaceFolders: readonly T[] | undefined,
    activeFileWorkspaceFolder: T | undefined,
    resourceWorkspaceFolder?: T
): T | undefined {
    if (resourceWorkspaceFolder) {
        return resourceWorkspaceFolder;
    }
    if (!workspaceFolders?.length) {
        return undefined;
    }
    if (workspaceFolders.length === 1) {
        return workspaceFolders[0];
    }
    return activeFileWorkspaceFolder ?? workspaceFolders[0];
}

export function findExecutableOnPath(
    executableName: string,
    platform: NodeJS.Platform,
    pathValue: string | undefined,
    exists: (value: string) => boolean
): string | undefined {
    const pathImplementation = platform === 'win32' ? path.win32 : path.posix;
    const delimiter = platform === 'win32' ? ';' : ':';
    const extension = platform === 'win32' && !path.win32.extname(executableName) ? '.exe' : '';

    for (const directory of pathValue?.split(delimiter) ?? []) {
        const candidate = pathImplementation.join(directory, executableName + extension);
        if (exists(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

export async function resolveSystemR(dependencies: SystemRResolverDependencies): Promise<string | undefined> {
    const fromPath = dependencies.findExecutable('R');
    if (fromPath) {
        return fromPath;
    }

    if (dependencies.platform === 'win32') {
        const installPath = await dependencies.getWindowsInstallPath();
        if (installPath) {
            return path.win32.join(installPath, 'bin', 'R.exe');
        }
    }
    return undefined;
}

export async function resolveBackgroundR(
    dependencies: RPathResolverDependencies,
    legacySetting: string,
    overwriteSetting?: string
): Promise<ExecutableResolution> {
    const settings = overwriteSetting
        ? [overwriteSetting, rExecutablePathSetting, legacySetting]
        : [rExecutablePathSetting, legacySetting];
    return resolveWithFallback(settings, dependencies);
}

export async function resolveConsoleR(
    dependencies: RPathResolverDependencies,
    legacySetting: string
): Promise<ExecutableResolution> {
    const configured = getMigratedSetting<string>(
        {
            get: dependencies.getSetting,
            inspect: dependencies.inspectSetting,
        },
        rConsolePathSetting,
        legacySetting,
        value => Boolean(removeWrappingQuotes(value.trim()).value)
    );
    if (configured) {
        const resolution = resolveConfiguredExecutable(configured.key, dependencies, configured.value);
        if (resolution) {
            return resolution;
        }
    }
    return resolveWithFallback([rExecutablePathSetting], dependencies);
}

export function formatRPath(
    resolution: ExecutableResolution,
    quote: boolean,
    platform: NodeJS.Platform
): string | undefined {
    if (!resolution.path || !quote) {
        return resolution.path;
    }

    if (resolution.quote) {
        if (platform === 'win32' && resolution.quote === '\'' && resolution.path.includes(' ')) {
            return `"${resolution.path}"`;
        }
        return `${resolution.quote}${resolution.path}${resolution.quote}`;
    }

    return resolution.path.includes(' ') ? `"${resolution.path}"` : resolution.path;
}

async function resolveWithFallback(
    settings: readonly string[],
    dependencies: RPathResolverDependencies
): Promise<ExecutableResolution> {
    for (const setting of settings) {
        const configured = resolveConfiguredExecutable(setting, dependencies);
        if (configured) {
            return configured;
        }
    }

    return { path: await dependencies.getSystemR() };
}

function resolveConfiguredExecutable(
    setting: string,
    dependencies: RPathResolverDependencies,
    rawValue = dependencies.getSetting(setting)
): ConfiguredExecutableResolution | undefined {
    if (!rawValue?.trim()) {
        return undefined;
    }

    const substituted = dependencies.substituteVariables(rawValue).trim();
    const { value, quote } = removeWrappingQuotes(substituted);
    if (!value) {
        return undefined;
    }

    const resolvedPath = isExecutableName(value)
        ? dependencies.findExecutable(value)
        : dependencies.pathExists(value) ? value : undefined;

    return { path: resolvedPath, setting, quote };
}

function removeWrappingQuotes(value: string): { value: string; quote?: '"' | '\'' } {
    if (value.length >= 2) {
        const first = value[0];
        if ((first === '"' || first === '\'') && value.at(-1) === first) {
            return { value: value.slice(1, -1), quote: first };
        }
    }
    return { value };
}

function isExecutableName(value: string): boolean {
    return !value.includes('/') && !value.includes('\\');
}
