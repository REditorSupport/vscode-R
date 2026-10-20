/** Dispose only the exact host currently registered at a key and address. */
export async function disposeJdvHostIfCurrentAddress<T>(
    hosts: Map<string, Promise<T>>,
    hostKey: string,
    expectedAddress: string,
    addressOf: (host: T) => string,
    dispose: (host: T) => void,
): Promise<boolean> {
    const pending = hosts.get(hostKey);
    if (!pending) {
        return false;
    }
    let host: T;
    try {
        host = await pending;
    } catch {
        if (hosts.get(hostKey) === pending) {
            hosts.delete(hostKey);
        }
        return false;
    }
    if (hosts.get(hostKey) !== pending || addressOf(host) !== expectedAddress) {
        return false;
    }
    hosts.delete(hostKey);
    dispose(host);
    return true;
}
