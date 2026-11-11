import {
    HttpgdClient,
    HttpgdIdResponse,
    HttpgdPlotRequest,
    HttpgdPlotsResponse,
    HttpgdRendererResponse,
} from './httpgdClient';

interface Device {
    origin: string;
    token?: string;
    client: HttpgdClient;
    plots: Map<string, string>;
    restoring: boolean;
    active: boolean;
    upid?: number;
}

interface PlotTarget {
    device: Device;
    id: string;
}

/** One session timeline; HTTP requests and credentials remain device-specific. */
export class HttpgdDevices {
    private devices = new Map<string, Device>();
    // Map insertion order is plot arrival order. Only IDs are grouped, never SVGs.
    private targets = new Map<string, PlotTarget>();
    private nextId = 0;
    private usedIds = new Set<string>();
    private connected = false;
    private listeners = new Set<
        (plots: HttpgdIdResponse[], restoring: boolean, changed: ReadonlySet<string>) => void
    >();

    constructor(origin: string, token?: string, restoring = false) {
        void this.addDevice(origin, token, restoring);
    }

    get connections(): Array<{ origin: string; token?: string }> {
        return [...this.devices.values()].map(({ origin, token }) => ({ origin, token }));
    }

    connection(origin: string): { origin: string; token?: string } | undefined {
        return this.devices.get(origin);
    }

    async addDevice(origin: string, token?: string, restoring = false): Promise<void> {
        const previous = this.devices.get(origin);
        if (previous && previous.token === token) {
            return;
        }
        if (previous) {
            this.removeDevice(origin);
        }
        const device: Device = {
            origin,
            token,
            client: new HttpgdClient(origin, token),
            plots: new Map(),
            restoring,
            active: false,
        };
        this.devices.set(origin, device);
        device.client.onPlotsChanged((snapshot) => this.update(device, snapshot));
        if (this.connected) {
            await device.client.connect();
        }
    }

    removeDevice(origin: string): void {
        const device = this.devices.get(origin);
        if (!device) {
            return;
        }
        this.devices.delete(origin);
        device.client.disconnect();
        for (const id of device.plots.values()) {
            this.targets.delete(id);
        }
        this.notify(true);
    }

    private update(device: Device, snapshot: HttpgdPlotsResponse): void {
        if (!this.connected || this.devices.get(device.origin) !== device) {
            return;
        }
        device.active = snapshot.state.active;
        const contentChanged = device.upid !== snapshot.state.upid;
        device.upid = snapshot.state.upid;
        if (device.active) {
            for (const other of this.devices.values()) {
                if (other !== device) {
                    other.active = false;
                }
            }
        }
        const incoming = new Set(snapshot.plots.map((plot) => plot.id));
        for (const [rawId, id] of device.plots) {
            if (!incoming.has(rawId)) {
                device.plots.delete(rawId);
                this.targets.delete(id);
            }
        }
        for (const rawId of incoming) {
            if (device.plots.has(rawId)) {
                continue;
            }
            // Preserve ordinary single-device IDs, allocating an alias only for
            // collisions. Routing never relies on parsing a server-supplied ID.
            let id = rawId;
            while (this.usedIds.has(id)) {
                id = `httpgd-${++this.nextId}`;
            }
            this.usedIds.add(id);
            device.plots.set(rawId, id);
            this.targets.set(id, { device, id: rawId });
        }
        const restoring = device.restoring;
        device.restoring = false;
        // Drawing updates the newest plot on this device. Historical plots are
        // immutable unless explicitly rendered at a new size by the viewer.
        const latest = snapshot.plots.at(-1)?.id;
        this.notify(
            restoring,
            new Set(!contentChanged || latest === undefined ? [] : [device.plots.get(latest)!]),
        );
    }

    private notify(restoring: boolean, changed: ReadonlySet<string> = new Set()): void {
        const plots = this.getPlots();
        for (const listener of this.listeners) {
            listener(plots, restoring, changed);
        }
    }

    onPlotsChanged(
        listener: (
            plots: HttpgdIdResponse[],
            restoring: boolean,
            changed: ReadonlySet<string>,
        ) => void,
    ): void {
        this.listeners.add(listener);
    }

    async connect(): Promise<void> {
        this.connected = true;
        // Start every connection even if one retained device has been closed in R.
        await Promise.all([...this.devices.values()].map((device) => device.client.connect()));
    }

    disconnect(): void {
        this.connected = false;
        for (const device of this.devices.values()) {
            device.restoring = true;
            device.client.disconnect();
        }
    }

    getPlots(): HttpgdIdResponse[] {
        return [...this.targets.keys()].map((id) => ({ id }));
    }

    releasePlots(): void {
        this.targets.clear();
        this.usedIds.clear();
        for (const device of this.devices.values()) {
            device.plots.clear();
        }
    }

    private target(id?: string): PlotTarget {
        const target = id === undefined ? undefined : this.targets.get(id);
        if (target) {
            return target;
        }
        if (id !== undefined) {
            throw new Error('Plot is no longer available');
        }
        const device = this.devices.values().next().value;
        if (!device) {
            throw new Error('No httpgd device is available');
        }
        return { device, id: '' };
    }

    plotConnection(id?: string): { origin: string; token?: string } {
        return this.target(id).device;
    }

    isActive(id: string): boolean {
        return this.targets.get(id)?.device.active !== false;
    }

    getRenderers(id?: string): HttpgdRendererResponse[] {
        return this.target(id).device.client.getRenderers();
    }

    async getPlotText(request: HttpgdPlotRequest): Promise<string> {
        return (await this.getPlotBytes(request)).toString('utf8');
    }

    async getPlotBytes(request: HttpgdPlotRequest): Promise<Buffer> {
        const target = this.target(request.id);
        const routed = { ...request, id: request.id === undefined ? undefined : target.id };
        // unigd replays resize requests on R's current graphics device. For an
        // inactive device, request its existing geometry and let SVG fit the
        // panel; replaying here can blank this plot and draw into another device.
        const dimensions = target.device.active
            ? {}
            : { width: undefined, height: undefined, zoom: undefined };
        return target.device.client.getPlotBytes({
            ...routed,
            ...dimensions,
        });
    }

    async removePlot(request: { id: string }): Promise<void> {
        const target = this.target(request.id);
        await target.device.client.removePlot({ id: target.id });
    }
}
