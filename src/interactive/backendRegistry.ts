import { AgentConfig, AgentSettings, BackendDescriptor, object } from './protocol';
import { SessionBackend } from './backend';
import { SessBackend, SessOptions } from './backends/sessBackend';
import { installAgentBundle } from './launcher';
import { installSessRuntime } from './backends/sessPreparation';
import { resolveArfExecutable } from './arfExecutable';

export interface PreparationContext {
    extensionPath: string;
    root: string;
    log(text: string): void;
}
export interface BackendDefinition {
    preflight(descriptor: BackendDescriptor, settings: AgentSettings): BackendDescriptor;
    prepare(descriptor: BackendDescriptor, context: PreparationContext): Promise<BackendDescriptor>;
    create(descriptor: BackendDescriptor, settings: AgentSettings): SessionBackend;
}

function sessOptions(descriptor: BackendDescriptor, prepared = true): SessOptions {
    const options = object(descriptor.options);
    for (const key of prepared ? ['rPath', 'library', 'resources'] : ['rPath']) {
        if (typeof options[key] !== 'string' || !options[key]) {
            throw new Error(`Missing sess backend ${key}`);
        }
    }
    if (
        !['r', 'arf'].includes(String(options.frontend)) ||
        !['managed', 'adopted'].includes(String(options.ownership)) ||
        !['auto', 'jgd', 'standard'].includes(String(options.plotBackend)) ||
        (options.frontend === 'r' && options.ownership !== 'managed')
    ) {
        throw new Error('Invalid sess backend configuration');
    }
    if (
        options.ownership === 'adopted' &&
        (typeof options.arfEndpoint !== 'string' || !options.arfEndpoint)
    ) {
        throw new Error('Missing arf endpoint');
    }
    return options as unknown as SessOptions;
}

const definitions: Readonly<Record<string, BackendDefinition>> = {
    sess: {
        preflight(descriptor, settings) {
            const options = sessOptions(descriptor, false);
            if (options.frontend === 'arf' && options.ownership === 'managed') {
                const arfPath = resolveArfExecutable(options.arfPath ?? 'arf', settings.directory);
                if (!arfPath) {
                    throw new Error(
                        'Cannot start Headless arf. Install arf or set r.interactive.arfPath to its executable.',
                    );
                }
                return { kind: 'sess', options: { ...options, arfPath } };
            }
            return descriptor;
        },
        async prepare(descriptor, context) {
            const options = sessOptions(descriptor, false);
            const runtime = await installSessRuntime(
                context.extensionPath,
                context.root,
                options.rPath,
                (text) => context.log(text),
            );
            return { kind: 'sess', options: { ...options, ...runtime } };
        },
        create(descriptor, settings) {
            return new SessBackend(settings, sessOptions(descriptor));
        },
    },
};

export function backendDefinition(kind: string): BackendDefinition {
    const definition = Object.hasOwn(definitions, kind) && definitions[kind];
    if (!definition) {
        throw new Error(`Unsupported Interactive backend: ${kind}`);
    }
    return definition;
}

/** The only conversion from flat, pre-abstraction agent configs. */
export function backendDescriptor(config: AgentConfig): BackendDescriptor {
    if (config.backend) {
        return config.backend;
    }
    if (!['r', 'arf', 'arf-existing'].includes(config.provider)) {
        throw new Error('Unsupported Interactive provider');
    }
    return {
        kind: 'sess',
        options: {
            frontend: config.provider === 'r' ? 'r' : 'arf',
            ownership: config.provider === 'arf-existing' ? 'adopted' : 'managed',
            rPath: config.rPath,
            library: config.library,
            resources: config.resources,
            arfPath: config.arfPath,
            arfEndpoint: config.arfEndpoint,
            plotBackend: config.plotBackend ?? 'auto',
        },
    };
}

/** Keep old extension readers working, deriving all legacy fields from the descriptor. */
export function withBackend(config: AgentConfig, backend: BackendDescriptor): AgentConfig {
    const common = { ...config };
    for (const key of [
        'rPath',
        'library',
        'resources',
        'arfPath',
        'arfEndpoint',
        'plotBackend',
    ] as const) {
        delete common[key];
    }
    if (backend.kind !== 'sess') {
        return { ...common, backend };
    }
    const options = sessOptions(backend);
    return {
        ...common,
        backend,
        rPath: options.rPath,
        library: options.library,
        resources: options.resources,
        arfPath: options.arfPath,
        arfEndpoint: options.arfEndpoint,
        plotBackend: options.plotBackend,
        provider:
            options.frontend === 'r'
                ? 'r'
                : options.ownership === 'adopted'
                  ? 'arf-existing'
                  : 'arf',
    };
}

export function createBackend(config: AgentConfig): SessionBackend {
    const descriptor = backendDescriptor(config);
    return backendDefinition(descriptor.kind).create(descriptor, config);
}

/** Selection is fixed internally; the optional definition is a test injection seam. */
export async function prepareBackendRuntime(
    config: AgentConfig,
    context: PreparationContext,
    definition = backendDefinition(backendDescriptor(config).kind),
): Promise<{ config: AgentConfig; agent: string }> {
    const selected = definition.preflight(backendDescriptor(config), config);
    const backend = definition.preflight(await definition.prepare(selected, context), config);
    const agent = installAgentBundle(context.extensionPath, context.root);
    return { config: withBackend(config, backend), agent };
}
