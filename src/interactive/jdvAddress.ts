export interface InteractiveJdvAddressOptions {
    sessionId: string;
    hostKey: string;
    canConnect(): boolean;
    isCurrent(): boolean;
    getAddress(sessionId: string, hostKey: string): Promise<string>;
    disposeHost(hostKey: string, expectedAddress: string): void | Promise<void>;
}

/** Acquire a session-scoped listener without returning an address to a stale client. */
export async function acquireInteractiveJdvAddress(options: InteractiveJdvAddressOptions): Promise<string> {
    if (!options.canConnect()) {
        throw new Error('Only the controlling Interactive client can connect the data viewer.');
    }
    const address = await options.getAddress(options.sessionId, options.hostKey);
    if (!options.canConnect() || !options.isCurrent()) {
        await options.disposeHost(options.hostKey, address);
        throw new Error('The Interactive session changed while opening its data viewer.');
    }
    return address;
}

/** Drop a listener when another client takes control of the same R process. */
export function disposeInteractiveJdvHostOnControlLoss(
    previouslyControlled: boolean, currentlyControlled: boolean, disposeHost: () => void,
): boolean {
    if (!previouslyControlled || currentlyControlled) { return false; }
    disposeHost();
    return true;
}
