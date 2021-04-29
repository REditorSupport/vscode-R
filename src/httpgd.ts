
import { Headers, Response } from 'node-fetch';

import * as WebSocket from 'ws';

import fetch from 'node-fetch';

import { HttpgdPlot, IHttpgdViewerApi, PlotId } from './httpgdTypes';


/**
 * State of the graphics device.
 * For details see: 
 * https://github.com/nx10/httpgd/blob/master/docs/api-documentation.md
 */
interface HttpgdState {
    upid: number,
    hsize: number,
    active: boolean
}

interface PlotsIdResponse {
    id: PlotId
}

interface PlotsResponse {
    state: HttpgdState,
    plots: PlotsIdResponse[]
}

/**
 * Light wrapper for httpgd API calls.
 */
class HttpgdApi {
    private readonly host: string;
    private readonly http: string;
    private readonly ws: string;
    private readonly httpSVG: string;
    private readonly httpState: string;
    private readonly httpRemove: string;
    private readonly httpClear: string;
    private readonly httpPlots: string;
    private readonly httpHeaders: Headers = new Headers();

    private readonly useToken: boolean;
    private readonly token: string;

    public constructor(host: string, token?: string) {
        this.host = host;
        this.http = 'http://' + host;
        this.ws = 'ws://' + host;
        this.httpSVG = this.http + '/svg';
        this.httpState = this.http + '/state';
        this.httpClear = this.http + '/clear';
        this.httpRemove = this.http + '/remove';
        this.httpPlots = this.http + '/plots';
        if (token) {
            this.useToken = true;
            this.token = token;
            this.httpHeaders.set('X-HTTPGD-TOKEN', this.token);
        } else {
            this.useToken = false;
            this.token = '';
        }
    }

    public svg_index(index: number, width?: number, height?: number, c?: string): URL {
        const url = this.svg_ext(width, height, c);
        url.searchParams.append('index', index.toString());
        return url;
    }

    public svg_id(id: PlotId, width?: number, height?: number, c?: string): URL {
        const url = this.svg_ext(width, height, c);
        url.searchParams.append('id', id);
        return url;
    }

    private svg_ext(width?: number, height?: number, c?: string): URL {
        const url = new URL(this.httpSVG);
        if (width) {url.searchParams.append('width', Math.round(width).toString());}
        if (height) {url.searchParams.append('height', Math.round(height).toString());}
        // Token needs to be included in query params because request headers can't be set
        // when setting image.src
        // upid is included to avoid caching
        if (this.useToken) {url.searchParams.append('token', this.token);}
        if (c) {url.searchParams.append('c', c);}
        return url;
    }
    
    private remove_index(index: number): URL {
        const url = new URL(this.httpRemove);
        url.searchParams.append('index', index.toString());
        return url;
    }

    public async get_remove_index(index: number): Promise<Response> {
        const res = await fetch(this.remove_index(index).href, {
            headers: this.httpHeaders
        });
        return res;
    }

    private remove_id(id: PlotId): URL {
        const url = new URL(this.httpRemove);
        url.searchParams.append('id', id);
        return url;
    }

    public async get_remove_id(id: PlotId): Promise<Response> {
        const res = await fetch(this.remove_id(id).href, {
            headers: this.httpHeaders
        });
        return res;
    }

    public async get_plots(): Promise<PlotsResponse> {
        const res = await fetch(this.httpPlots, {
            headers: this.httpHeaders
        });
        return await (res.json() as Promise<PlotsResponse>);
    }
    
    public async get_plot_contents_all(): Promise<HttpgdPlot[]> {
        const plotIds = await this.get_plots();
        const plots = plotIds.plots.map(async idRes => {
            return await this.get_plot_contents(idRes.id);
        });
        return await Promise.all(plots);
    }

    public async get_plot_contents(id: PlotId, width?: number, height?: number, c?: string): Promise<HttpgdPlot> {
        const url = this.svg_id(id, width, height, c).toString();
        const plot = fetch(url).then(res => res.text()).then(res => {
            return {
                url: url,
                host: this.host,
                id: id,
                svg: res,
                height: height,
                width: width,
            };
        });
        return plot;
    }


    public async get_clear(): Promise<Response> {
        const res = await fetch(this.httpClear, {
            headers: this.httpHeaders
        });
        return res;
    }

    public async get_state(): Promise<HttpgdState> {
        const res = await fetch(this.httpState, {
            headers: this.httpHeaders
        });
        return await (res.json() as Promise<HttpgdState>);
    }

    public new_websocket(): WebSocket {
        return new WebSocket(this.ws);
    }
}

const enum HttpgdConnectionMode {
    NONE,
    POLL,
    SLOWPOLL,
    WEBSOCKET
}

/**
 * Handles HTTP polling / WebSocket connection.
 * This handles falling back to HTTP polling when WebSockets are not available,
 * and automatically reconnects if the server is temporarily unavailable.
 */
class HttpgdConnection {
    private static readonly INTERVAL_POLL: number = 500;
    private static readonly INTERVAL_POLL_SLOW: number = 5000;

    public api: HttpgdApi;

    private mode: HttpgdConnectionMode = HttpgdConnectionMode.NONE;
    private allowWebsockets: boolean;

    private socket?: WebSocket;
    private pollHandle?: ReturnType<typeof setInterval>;

    private pausePoll: boolean = false;
    private disconnected: boolean = true;

    private lastState?: HttpgdState;

    public remoteStateChanged?: (newState: HttpgdState) => void;
    public connectionChanged?: (disconnected: boolean) => void;

    public constructor(host: string, token?: string, allowWebsockets?: boolean) {
        this.api = new HttpgdApi(host, token);
        this.allowWebsockets = allowWebsockets ? allowWebsockets : false;
    }

    public open(): void {
        if (this.mode !== HttpgdConnectionMode.NONE) {return;}
        this.start(HttpgdConnectionMode.WEBSOCKET);
    }

    public close(): void {
        if (this.mode === HttpgdConnectionMode.NONE) {return;}
        this.start(HttpgdConnectionMode.NONE);
    }

    private start(targetMode: HttpgdConnectionMode): void {
        if (this.mode === targetMode) {return;}

        switch (targetMode) {
            case HttpgdConnectionMode.POLL:
                console.log('Start POLL');
                this.clearWebsocket();
                this.clearPoll();
                this.pollHandle = setInterval(() => this.poll(), HttpgdConnection.INTERVAL_POLL);
                this.mode = targetMode;
                break;
            case HttpgdConnectionMode.SLOWPOLL:
                console.log('Start SLOWPOLL');
                this.clearWebsocket();
                this.clearPoll();
                this.pollHandle = setInterval(() => this.poll(), HttpgdConnection.INTERVAL_POLL_SLOW);
                this.mode = targetMode;
                break;
            case HttpgdConnectionMode.WEBSOCKET:
                if (!this.allowWebsockets) {
                    this.start(HttpgdConnectionMode.POLL);
                    break;
                }
                console.log('Start WEBSOCKET');
                this.clearPoll();
                this.clearWebsocket();

                this.socket = this.api.new_websocket();
                this.socket.onmessage = (ev) => this.onWsMessage(ev.data.toString());
                this.socket.onopen = () => this.onWsOpen();
                this.socket.onclose = () => this.onWsClose();
                this.socket.onerror = () => console.log('Websocket error');
                this.mode = targetMode;
                this.poll(); // get initial state
                break;
            case HttpgdConnectionMode.NONE:
                this.clearWebsocket();
                this.clearPoll();
                this.mode = targetMode;
                break;
            default:
                break;
        }

    }

    private clearPoll() {
        if (this.pollHandle) {
            clearInterval(this.pollHandle);
        }
    }

    private clearWebsocket() {
        if (this.socket) {
            this.socket.onclose = () => { /* ignore? */ };
            this.socket.close();
        }
    }

    private poll(): void {
        if (this.pausePoll) {return;}
        this.api.get_state().then((remoteState: HttpgdState) => {
            this.setDisconnected(false);
            if (this.mode === HttpgdConnectionMode.SLOWPOLL) {this.start(HttpgdConnectionMode.WEBSOCKET);} // reconnect
            if (this.pausePoll) {return;}
            this.checkState(remoteState);
        }).catch((e) => {
            console.warn(e);
            this.setDisconnected(true);
        });
    }

    private onWsMessage(message: string): void {
        if (message.startsWith('{')) {
            const remoteState = JSON.parse(message) as HttpgdState;
            this.checkState(remoteState);
        } else {
            console.log('Unknown WS message: ' + message);
        }
    }
    private onWsClose(): void {
        console.log('Websocket closed');
        this.setDisconnected(true);
    }
    private onWsOpen(): void {
        console.log('Websocket opened');
        this.setDisconnected(false);
    }

    private setDisconnected(disconnected: boolean): void {
        if (this.disconnected !== disconnected) {
            this.disconnected = disconnected;
            if (this.disconnected) {
                this.start(HttpgdConnectionMode.SLOWPOLL);
            } else {
                this.start(HttpgdConnectionMode.WEBSOCKET);
            }
            this.connectionChanged?.(disconnected);
        }
    }

    private checkState(remoteState: HttpgdState): void {
        if (
            (!this.lastState) ||
            (this.lastState.active !== remoteState.active) ||
            (this.lastState.hsize !== remoteState.hsize) ||
            (this.lastState.upid !== remoteState.upid)
        ) {
            this.lastState = remoteState;
            this.remoteStateChanged?.(remoteState);
        }
    }
}

/**
 * Public API for communicating with a httpgd server.
 */
export class Httpgd implements IHttpgdViewerApi {

    private connection: HttpgdConnection;
    
    // Constructor is called by the viewer:
    public constructor(host: string, token?: string)
    {
        this.connection = new HttpgdConnection(host, token, true);
    }

    // Opens the connection to the server
    public start(): void {
        this.connection.open();
    }
    
    // api calls:
    // general state info:
    public getState(): Promise<HttpgdState> {
        return this.connection.api.get_state();
    }
    // get list of plot Ids:
    public getPlotIds(): Promise<PlotId[]> {
        return this.connection.api.get_plots().then(res => res.plots.map(r => r.id));
    }
    // get content of a single plot. Use sensible defaults if no height/width given:
    public getPlotContent(id: PlotId, height?: number, width?: number, c?: string): Promise<HttpgdPlot> {
        return this.connection.api.get_plot_contents(id, width, height, c);
    }
    // get content of multiple plots:
    // Use sensible defaults if no height/width given.
    // Return all plots if no ids given.
    public getPlotContents(ids?: PlotId[], height?: number, width?: number): Promise<HttpgdPlot[]> {
        if (!ids) {
            return this.connection.api.get_plot_contents_all();
        }
        const plots = ids.map(async id => {
            return await this.connection.api.get_plot_contents(id, width, height);
        });
        return Promise.all(plots);
    } 
    
    // close/remove plot
    public async closePlot(id: PlotId): Promise<void> {
        await this.connection.api.get_remove_id(id);
    }
    
    // Listen to connection changes of the httpgd server
    // Todo: Expand to fill observer pattern with multiple listeners (?)
    public onConnectionChange(listener: (disconnected: boolean) => void): void {
        this.connection.connectionChanged = listener;
    }
    
    // Listen to plot changes of the httpgd server
    // Todo: Expand to fill observer pattern with multiple listeners (?)
    public onPlotsChange(listener: () => void): void {
        this.connection.remoteStateChanged = listener;
    }
    
    // Dispose-function to clean up when vscode closes
    public dispose(): void {
        this.connection.close();
    }
}
