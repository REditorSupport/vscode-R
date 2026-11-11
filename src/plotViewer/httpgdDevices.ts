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
    available: boolean;
    upid?: number;
}

interface PlotTarget {
    device: Device;
    id: string;
    position: number;
}

export interface HttpgdPlotReference {
    origin: string;
    id: string;
}

/** One session timeline; HTTP requests and credentials remain device-specific. */
export class HttpgdDevices {
    private devices = new Map<string, Device>();
    // Map insertion order is plot arrival order. Only IDs are grouped, never SVGs.
    private targets = new Map<string, PlotTarget>();
    private nextId = 0;
    private usedIds = new Set<string>();
    private order = new Map<string, { plot: HttpgdPlotReference; position: number }>();
    private nextPosition = 0;
    private connected = false;
    private unavailableListeners = new Set<() => void>();
    private listeners = new Set<
        (
            plots: HttpgdIdResponse[],
            restoring: boolean,
            changed: ReadonlySet<string>,
            orderChanged: boolean,
        ) => void
    >();

    constructor(
        origin: string,
        token?: string,
        restoring = false,
        order: HttpgdPlotReference[] = [],
    ) {
        for (const plot of order) {
            this.rememberPlot(plot);
        }
        void this.addDevice(origin, token, restoring);
    }

    get plotOrder(): HttpgdPlotReference[] {
        return [...this.order.values()].map(({ plot }) => ({ ...plot }));
    }

    private rememberPlot(plot: HttpgdPlotReference): number {
        const key = JSON.stringify([plot.origin, plot.id]);
        let entry = this.order.get(key);
        if (!entry) {
            entry = { plot, position: this.nextPosition++ };
            this.order.set(key, entry);
        }
        return entry.position;
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
            available: true,
        };
        this.devices.set(origin, device);
        device.client.onPlotsChanged((snapshot) => this.update(device, snapshot));
        device.client.onUnavailable(() => {
            if (!this.connected || this.devices.get(origin) !== device || !device.available) {
                return;
            }
            device.available = false;
            device.active = false;
            for (const listener of this.unavailableListeners) {
                listener();
            }
        });
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
        for (const [key, { plot }] of this.order) {
            if (plot.origin === origin) {
                this.order.delete(key);
            }
        }
        this.notify(true, new Set(), true);
    }

    private update(device: Device, snapshot: HttpgdPlotsResponse): void {
        if (!this.connected || this.devices.get(device.origin) !== device) {
            return;
        }
        device.active = snapshot.state.active;
        device.available = true;
        const contentChanged = device.upid !== snapshot.state.upid;
        device.upid = snapshot.state.upid;
        if (device.active) {
            for (const other of this.devices.values()) {
                if (other !== device && other.active) {
                    other.active = false;
                    // dev.off() can leave httpgd's WebSocket open. Check the
                    // previous device when R activates its successor.
                    void other.client.refreshState().catch(() => undefined);
                }
            }
        }
        const incoming = new Set(snapshot.plots.map((plot) => plot.id));
        let orderChanged = false;
        // Reconcile only this device: other restored devices may not have
        // delivered their first snapshot yet.
        for (const [key, { plot }] of this.order) {
            if (plot.origin === device.origin && !incoming.has(plot.id)) {
                this.order.delete(key);
                orderChanged = true;
            }
        }
        for (const [rawId, id] of device.plots) {
            if (!incoming.has(rawId)) {
                device.plots.delete(rawId);
                this.targets.delete(id);
            }
        }
        let restoreOrder = false;
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
            const saved = this.order.has(JSON.stringify([device.origin, rawId]));
            restoreOrder ||= saved;
            orderChanged ||= !saved;
            this.targets.set(id, {
                device,
                id: rawId,
                position: this.rememberPlot({ origin: device.origin, id: rawId }),
            });
        }
        if (restoreOrder) {
            this.targets = new Map([...this.targets].sort((a, b) => a[1].position - b[1].position));
        }
        const restoring = device.restoring;
        device.restoring = false;
        // Drawing updates the newest plot on this device. Historical plots are
        // immutable unless explicitly rendered at a new size by the viewer.
        const latest = snapshot.plots.at(-1)?.id;
        this.notify(
            restoring,
            new Set(!contentChanged || latest === undefined ? [] : [device.plots.get(latest)!]),
            orderChanged,
        );
    }

    private notify(
        restoring: boolean,
        changed: ReadonlySet<string> = new Set(),
        orderChanged = false,
    ): void {
        const plots = this.getPlots();
        for (const listener of this.listeners) {
            listener(plots, restoring, changed, orderChanged);
        }
    }

    onPlotsChanged(
        listener: (
            plots: HttpgdIdResponse[],
            restoring: boolean,
            changed: ReadonlySet<string>,
            orderChanged: boolean,
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
        this.order.clear();
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
        return { device, id: '', position: -1 };
    }

    plotConnection(id?: string): { origin: string; token?: string } {
        return this.target(id).device;
    }

    isActive(id: string): boolean {
        return this.targets.get(id)?.device.active !== false;
    }

    onDeviceUnavailable(listener: () => void): void {
        this.unavailableListeners.add(listener);
    }

    async nextAvailablePlot(
        id?: string,
        visible?: ReadonlySet<string>,
    ): Promise<string | undefined> {
        const current = id === undefined ? undefined : this.targets.get(id);
        if (!current || current.device.available) {
            return undefined;
        }
        const latest = new Map<Device, string>();
        for (const [plotId, target] of this.targets) {
            if (!visible || visible.has(plotId)) {
                latest.set(target.device, plotId);
            }
        }
        const devices = [...this.devices.values()];
        const start = devices.indexOf(current.device);
        for (let offset = 1; offset < devices.length; offset++) {
            const device = devices[(start + offset) % devices.length];
            if (device.available && latest.has(device)) {
                // An inactive device may have been closed without a socket
                // notification. Verify the successor before selecting it.
                try {
                    await device.client.refreshState();
                    return latest.get(device);
                } catch {
                    continue;
                }
            }
        }
        return undefined;
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
        return target.device.client.getPlotBytes({ ...routed, ...dimensions });
    }

    async removePlot(request: { id: string }): Promise<void> {
        const target = this.target(request.id);
        await target.device.client.removePlot({ id: target.id });
    }
}
