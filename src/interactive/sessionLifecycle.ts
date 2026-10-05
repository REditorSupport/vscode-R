import { AgentClient, probeSession } from './client';
import { SessionManifest } from './protocol';

/** Probe only registered Interactive agents, without taking their control leases. */
export async function runningSessions(candidates: SessionManifest[]): Promise<SessionManifest[]> {
    const live: SessionManifest[] = [];
    const unique = [
        ...new Map(
            candidates.map((manifest) => [`${manifest.id}:${manifest.generation}`, manifest]),
        ).values(),
    ];
    for (let i = 0; i < unique.length; i += 8) {
        const batch = await Promise.all(
            unique.slice(i, i + 8).map((manifest) => probeSession(manifest)),
        );
        for (const manifest of batch) {
            if (manifest && !['exited', 'stopping'].includes(manifest.status)) {
                live.push(manifest);
            }
        }
    }
    return live;
}

/** Stop the confirmed generation without opening a notebook or taking control from another window. */
export async function stopSession(manifest: SessionManifest, clientId: string): Promise<void> {
    const client = new AgentClient({ ...manifest }, clientId);
    try {
        await client.connect({ claim: false, timeout: 1500 });
        if (client.manifest.status === 'exited') {
            return;
        }
        if (!(await client.request<boolean>('claim', {}, 1500))) {
            throw new Error(
                'Controlled by another window. Use Take Control of Interactive Session before retrying.',
            );
        }
        await client.request('stop', {}, 5000);
        // A stop reply acknowledges the request; wait for process exit before reporting success.
        const deadline = Date.now() + 8000;
        do {
            await new Promise((resolve) => setTimeout(resolve, 100));
            const heartbeat = await client.request<{ status: SessionManifest['status'] }>(
                'heartbeat',
                {},
                1500,
            );
            if (heartbeat.status === 'exited') {
                return;
            }
        } while (Date.now() < deadline);
        throw new Error(
            'Stop was requested, but R has not exited yet. Refresh the session list to check its state.',
        );
    } finally {
        // Do not detach: an open view in this window shares the same client ID.
        client.close();
    }
}
