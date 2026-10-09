import { getHttpResponse } from '../http';

export type HttpgdPlotId = string;
export type HttpgdRendererId = string;
export interface HttpgdIdResponse { id: HttpgdPlotId }
export interface HttpgdState { upid: number; hsize: number; active: boolean }
export interface HttpgdPlotsResponse { state: HttpgdState; plots: HttpgdIdResponse[] }
export interface HttpgdRendererResponse { id: string; name: string; ext: string; descr: string }
export interface HttpgdPlotRequest {
    id?: string;
    renderer?: string;
    width?: number;
    height?: number;
    zoom?: number;
}

interface ClientOptions {
    pollIntervalMs?: number;
    retryIntervalMs?: number;
    webSocketTimeoutMs?: number;
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function state(value: unknown): HttpgdState {
    if (!record(value) || typeof value.upid !== 'number' || !Number.isFinite(value.upid)
        || typeof value.hsize !== 'number' || !Number.isFinite(value.hsize) || typeof value.active !== 'boolean') {
        throw new Error('Invalid httpgd state');
    }
    return { upid: value.upid, hsize: value.hsize, active: value.active };
}

// Protocol client only: rendering and viewer commands remain in HttpgdViewer.
export class HttpgdClient {
    private readonly base: URL;
    private readonly headers: Record<string, string>;
    private readonly pollInterval: number;
    private readonly retryInterval: number;
    private readonly webSocketTimeout: number;
    private controller?: AbortController;
    private socket?: WebSocket;
    private pollTimer?: NodeJS.Timeout;
    private polling = false;
    private socketTimer?: NodeJS.Timeout;
    private retryAt = 0;
    private snapshot?: HttpgdPlotsResponse;
    private renderers: HttpgdRendererResponse[] = [];
    private renderersLoaded = false;
    private refreshTask?: Promise<void>;
    private refreshPending = false;
    private readonly listeners = new Set<(value: HttpgdPlotsResponse) => void>();

    constructor(host: string, token?: string, options: ClientOptions = {}) {
        this.base = new URL(host.includes('://') ? host : `http://${host}`);
        this.headers = token ? { 'X-HTTPGD-TOKEN': token } : {};
        this.pollInterval = options.pollIntervalMs ?? 500;
        this.retryInterval = options.retryIntervalMs ?? 15000;
        this.webSocketTimeout = options.webSocketTimeoutMs ?? 5000;
    }

    public async connect(): Promise<void> {
        if (this.controller) { return; }
        this.controller = new AbortController();
        try {
            await this.loadRenderers();
            await this.refreshPlots();
        } finally {
            if (this.controller && !this.controller.signal.aborted) {
                this.openWebSocket();
                this.schedulePoll();
            }
        }
    }

    public disconnect(): void {
        this.controller?.abort();
        this.controller = undefined;
        clearTimeout(this.pollTimer);
        this.closeWebSocket();
    }

    public onPlotsChanged(listener: (value: HttpgdPlotsResponse) => void): void {
        this.listeners.add(listener);
    }

    public getPlots(): HttpgdIdResponse[] { return this.snapshot?.plots ?? []; }
    public getRenderers(): HttpgdRendererResponse[] { return this.renderers; }

    public async getPlotText(request: HttpgdPlotRequest): Promise<string> {
        return (await this.getPlotBytes(request)).toString('utf8');
    }

    public async getPlotBytes(request: HttpgdPlotRequest): Promise<Buffer> {
        const url = this.url('/plot');
        for (const [name, value] of Object.entries(request) as [string, string | number | undefined][]) {
            if (value !== undefined) {
                const parameter = name === 'width' || name === 'height' ? Math.round(Number(value)) : value;
                url.searchParams.set(name, String(parameter));
            }
        }
        return this.request(url);
    }

    public async removePlot(request: { id: string }): Promise<void> {
        const url = this.url('/remove');
        url.searchParams.set('id', request.id);
        state(await this.json(url));
        await this.refreshPlots();
    }

    private url(path: string): URL { return new URL(path, this.base); }

    private async request(url: URL): Promise<Buffer> {
        const signal = this.controller?.signal;
        if (!signal || signal.aborted) { throw new Error('httpgd client is disconnected'); }
        const response = await getHttpResponse(url, { headers: this.headers, signal, timeoutMs: 10000 });
        if (response.status !== 200) { throw new Error(`httpgd request failed (${response.status})`); }
        return response.body;
    }

    private async json(url: URL): Promise<unknown> {
        return JSON.parse((await this.request(url)).toString('utf8')) as unknown;
    }

    private async loadRenderers(): Promise<void> {
        const value = await this.json(this.url('/renderers'));
        if (!record(value) || !Array.isArray(value.renderers)) { throw new Error('Invalid httpgd renderers'); }
        this.renderers = value.renderers.map((renderer: unknown) => {
            if (!record(renderer) || typeof renderer.id !== 'string' || typeof renderer.name !== 'string'
                || typeof renderer.ext !== 'string' || typeof renderer.descr !== 'string') {
                throw new Error('Invalid httpgd renderer');
            }
            return { id: renderer.id, name: renderer.name, ext: renderer.ext, descr: renderer.descr };
        });
        this.renderersLoaded = true;
    }

    private refreshPlots(): Promise<void> {
        this.refreshPending = true;
        if (!this.refreshTask) {
            this.refreshTask = this.drainPlots().finally(() => { this.refreshTask = undefined; });
        }
        return this.refreshTask;
    }

    private async drainPlots(): Promise<void> {
        while (this.refreshPending && this.controller) {
            this.refreshPending = false;
            const value = await this.json(this.url('/plots'));
            if (!record(value) || !Array.isArray(value.plots)) { throw new Error('Invalid httpgd plots'); }
            const plots = value.plots.map((plot: unknown) => {
                if (!record(plot) || typeof plot.id !== 'string') { throw new Error('Invalid httpgd plot ID'); }
                return { id: plot.id };
            });
            this.snapshot = { state: state(value.state), plots };
            // TODO: Revisit this notification boundary if httpgd and JGD viewer
            // updates are unified. Their transports remain separate for now.
            for (const listener of this.listeners) { listener(this.snapshot); }
        }
    }

    private async updateState(value: unknown): Promise<void> {
        const next = state(value);
        const previous = this.snapshot?.state;
        if (!previous || previous.upid !== next.upid || previous.hsize !== next.hsize || previous.active !== next.active) {
            await this.refreshPlots();
        }
    }

    private schedulePoll(delay = this.pollInterval): void {
        clearTimeout(this.pollTimer);
        if (this.controller && this.socket?.readyState !== 1) {
            this.pollTimer = setTimeout(() => { void this.poll(); }, delay);
        }
    }

    private async poll(): Promise<void> {
        if (!this.controller || this.polling) { return; }
        this.polling = true;
        let delay = this.pollInterval;
        try {
            if (!this.renderersLoaded) { await this.loadRenderers(); }
            await this.updateState(await this.json(this.url('/state')));
            if (!this.socket && Date.now() >= this.retryAt) { this.openWebSocket(); }
        } catch {
            delay = this.retryInterval;
        } finally {
            this.polling = false;
            this.schedulePoll(delay);
        }
    }

    private openWebSocket(): void {
        // TODO: Remove this missing-WebSocket compatibility path when the minimum
        // extension host provides Node 22. Keep polling for connection failures.
        if (typeof globalThis.WebSocket !== 'function' || !this.controller || this.socket) { return; }
        this.retryAt = Date.now() + this.retryInterval;
        const url = this.url('/');
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const token = this.headers['X-HTTPGD-TOKEN'];
        if (token) { url.searchParams.set('token', token); }
        try {
            const socket = new WebSocket(url);
            this.socket = socket;
            const fallback = () => {
                if (this.socket !== socket) { return; }
                this.closeWebSocket();
                this.schedulePoll();
            };
            this.socketTimer = setTimeout(fallback, this.webSocketTimeout);
            socket.onopen = () => {
                clearTimeout(this.socketTimer);
                clearTimeout(this.pollTimer);
                // Resync after every connection: changes during reconnect may have been missed.
                void this.refreshPlots().catch(fallback);
            };
            socket.onmessage = event => {
                if (typeof event.data !== 'string') { return; }
                try {
                    void this.updateState(JSON.parse(event.data) as unknown).catch(fallback);
                } catch { fallback(); }
            };
            socket.onclose = fallback;
            socket.onerror = fallback;
        } catch {
            this.schedulePoll();
        }
    }

    private closeWebSocket(): void {
        clearTimeout(this.socketTimer);
        const socket = this.socket;
        this.socket = undefined;
        if (socket) {
            socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
            socket.close();
        }
    }
}
