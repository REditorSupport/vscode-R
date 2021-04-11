
import { Headers, Response } from 'node-fetch';

import * as WebSocket from 'ws';

import fetch from 'node-fetch';

// httpgd connection ----------------------------------------------------------

interface HttpgdState {
    upid: number,
    hsize: number,
    active: boolean
}

interface HttpgdId {
    id: string
}

interface HttpgdPlots {
    state: HttpgdState,
    plots: HttpgdId[]
}

class HttpgdApi {
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

    public svg_id(id: string, width?: number, height?: number, c?: string): URL {
        const url = this.svg_ext(width, height, c);
        url.searchParams.append('id', id);
        return url;
    }
    
    public async svg_content(url: string): Promise<string> {
        const res = await fetch(url);
        return await res.text();
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

    private remove_id(id: string): URL {
        const url = new URL(this.httpRemove);
        url.searchParams.append('id', id);
        return url;
    }

    public async get_remove_id(id: string): Promise<Response> {
        const res = await fetch(this.remove_id(id).href, {
            headers: this.httpHeaders
        });
        return res;
    }

    public async get_plots(): Promise<HttpgdPlots> {
        const res = await fetch(this.httpPlots, {
            headers: this.httpHeaders
        });
        return await (res.json() as Promise<HttpgdPlots>);
    }
    
    public async get_plot_contents(): Promise<string[]> {
        const plotIds = await this.get_plots();
        const plots = plotIds.plots.map(async id => {
            const url = this.svg_id(id.id);
            const plot = await this.svg_content(url.toString());
            return plot;
        });
        return await Promise.all(plots);
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
// Handles HTTP polling / websocket connection
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

// httpgd viewer --------------------------------------------------------------

class HttpgdNavigator {
    private data?: HttpgdPlots;
    private index: number = -1;
    private width: number = 0;
    private height: number = 0;

    private last_id: string = '';
    private last_width: number = 0;
    private last_height: number = 0;

    public navigate(offset: number): void {
        if (!this.data) {return;}
        this.index = (this.data.plots.length + this.index + offset) % this.data.plots.length;
    }

    public jump(index: number): void {
        if (!this.data) {return;}
        this.index = (this.data.plots.length + index) % this.data.plots.length;
    }

    public jump_id(id: string): void {
        if (!this.data) {return;}
        for (let i = 0; i < this.data.plots.length; i++) {
            if (id === this.data.plots[i].id) {
                this.index = i;
                break;
            }
        }
    }

    public resize(width: number, height: number): void {
        this.width = width;
        this.height = height;
    }

    public next(api: HttpgdApi, c?: string): string | undefined {
        if (!this.data || this.data.plots.length === 0) {return './plot-none.svg';}
        if ((this.last_id !== this.data.plots[this.index].id) ||
            (Math.abs(this.last_width - this.width) > 0.1) ||
            (Math.abs(this.last_height - this.height) > 0.1))
            {return api.svg_id(this.data.plots[this.index].id, this.width, this.height, c).href;}
        return undefined;
    }

    public update(data: HttpgdPlots) {
        this.data = data;
        this.index = data.plots.length - 1;
    }

    public id(): string | undefined {
        if (!this.data || this.data.plots.length === 0) {return undefined;}
        return this.data.plots[this.index].id;
    }

    public indexStr(): string {
        if (!this.data) {return '0/0';}
        return `${Math.max(0, this.index + 1)}/${this.data.plots.length}`;
    }
}

export class HttpgdViewer {
    static readonly COOLDOWN_RESIZE: number = 200;
    static readonly SCALE_DEFAULT: number = 0.8;
    static readonly SCALE_STEP: number = HttpgdViewer.SCALE_DEFAULT / 12.0;

    private navi: HttpgdNavigator = new HttpgdNavigator();
    private plotUpid: number = -1;
    private scale: number = HttpgdViewer.SCALE_DEFAULT; // zoom level

    private connection: HttpgdConnection;
    private deviceActive: boolean = true;
    
    private svg: string = '';
    private plots: string[] = [];
    private sidebar: string = '';
    
    private listeners: ((plots: string[]) => void)[] = [];

    public onDeviceActiveChange?: (deviceActive: boolean) => void;
    public onDisconnectedChange?: (disconnected: boolean) => void;
    public onIndexStringChange?: (indexString: string) => void;
    public onZoomStringChange?: (zoomString: string) => void;

    public constructor(host: string, token?: string, allowWebsockets?: boolean) {
        this.connection = new HttpgdConnection(host, token, allowWebsockets);
        this.connection.remoteStateChanged = (remoteState: HttpgdState) => this.serverChanges(remoteState);
        this.connection.connectionChanged = (disconnected: boolean) => this.onDisconnectedChange?.(disconnected);
    }
    
    public onChange(listener: (plots: string[]) => void): void {
        this.listeners.push(listener);
    }
    private didChange(): void {
        for(const listener of this.listeners){
            listener(this.plots);
        }
    }

    public init(): void {
        this.connection.open();
        this.checkResize();

        // Force reload on visibility change
        // Firefox otherwise shows a blank screen on tab change 
        // document.addEventListener('visibilitychange', () => {
        //     if (!document.hidden) {
        //         this.updateImage('v');
        //     }
        // }, false);

        this.onIndexStringChange?.(this.navi.indexStr());
        this.onZoomStringChange?.(this.getZoomString());

        console.log('initial update plots');
        this.updatePlots(true);
    }

    private updatePlots(scroll: boolean = false) {
        void this.connection.api.get_plots().then(plots => {
            this.navi.update(plots);
            this.onIndexStringChange?.(this.navi.indexStr());
            this.updateSidebar(plots, scroll);
            this.updateImage();
        });
    }

    private updateImage(c?: string) {
        const n = this.navi.next(this.connection.api, `${this.plotUpid}${c || ''}`);
        if (n) {
            void this.updateSvg(n);
        }
    }
    
    private async updateSvg(n: string){
        this.svg = await this.connection.api.svg_content(n);
        this.plots = await this.connection.api.get_plot_contents();
        this.didChange();
    }

    private updateSidebar(plots: HttpgdPlots, scroll: boolean = false) {
        // if (!this.sidebar) {return;}

        // //this.sidebar.innerHTML = '';

        // let idx = 0;
        // while (idx < this.sidebar.children.length) {
        //     if (idx >= plots.plots.length || this.sidebar.children[idx].getAttribute('data-pid') !== plots.plots[idx].id) {
        //         this.sidebar.removeChild(this.sidebar.children[idx]);
        //     } else {
        //         idx++;
        //     }
        // }

        // for (; idx < plots.plots.length; ++idx) {
        //     const p = plots.plots[idx];
        //     const elem_card = document.createElement('div');
        //     elem_card.setAttribute('data-pid', p.id);
        //     const elem_x = document.createElement('a');
        //     elem_x.innerHTML = '&#10006;';
        //     elem_x.onclick = () => {
        //         void this.connection.api.get_remove_id(p.id);
        //         this.updatePlots();
        //     };
        //     const elem_img = document.createElement('img');
        //     elem_card.classList.add('history-item');
        //     elem_img.setAttribute('src', this.connection.api.svg_id(p.id).href);
        //     elem_card.onclick = () => {
        //         this.navi.jump_id(p.id);
        //         this.onIndexStringChange?.(this.navi.indexStr());
        //         this.updateImage();
        //     };
        //     elem_card.appendChild(elem_img);
        //     elem_card.appendChild(elem_x);
        //     this.sidebar.appendChild(elem_card);
        // }

        // if (scroll) {
        //     this.sidebar.scrollTop = this.sidebar.scrollHeight;
        // }
    }

    // checks if there were server side changes
    private serverChanges(remoteState: HttpgdState): void {
        this.setDeviceActive(!remoteState.active);
        const lastUpid = this.plotUpid;
        this.plotUpid = remoteState.upid;
        if (lastUpid !== remoteState.upid)
            {this.updatePlots(true);}
    }

    private setDeviceActive(active: boolean): void {
        if (this.deviceActive !== active) {
            this.deviceActive = active;
            this.onDeviceActiveChange?.(active);
        }
    }

    // User interaction
    public zoomIn(): void {
        if (this.scale - HttpgdViewer.SCALE_STEP > 0.05) {
            this.scale -= HttpgdViewer.SCALE_STEP;
        }
        this.onZoomStringChange?.(this.getZoomString());
        this.checkResize();
    }
    public zoomOut(): void {
        this.scale += HttpgdViewer.SCALE_STEP;
        this.onZoomStringChange?.(this.getZoomString());
        this.checkResize();
    }
    public zoomReset(): void {
        this.scale = HttpgdViewer.SCALE_DEFAULT;
        this.onZoomStringChange?.(this.getZoomString());
        this.checkResize();
    }
    public getZoomString(): string {
        const pct = Math.ceil(HttpgdViewer.SCALE_DEFAULT / this.scale * 100);
        return `${pct}%`;
    }
    public navPrevious(): void {
        this.navi.navigate(-1);
        this.onIndexStringChange?.(this.navi.indexStr());
        this.updateImage();
    }
    public navNext(): void {
        this.navi.navigate(1);
        this.onIndexStringChange?.(this.navi.indexStr());
        this.updateImage();
    }
    public navNewest(): void {
        this.navi.jump(-1);
        this.onIndexStringChange?.(this.navi.indexStr());
        this.updateImage();
    }
    public navClear(): void {
        void this.connection.api.get_clear();
        this.updatePlots();
    }
    public navRemove(): void {
        const id = this.navi.id();
        if (id) {
            void this.connection.api.get_remove_id(id);
            this.updatePlots();
        }
    }

    private static downloadURL(url: string, filename?: string) {
        // const dl = document.createElement('a');
        // dl.href = url;
        // if (filename) { dl.download = filename; }
        // document.body.appendChild(dl);
        // dl.click();
        // document.body.removeChild(dl);
    }
    public downloadPlotSVG(image: HTMLImageElement): void {
        // if (!this.navi.id()) {return;}
        // void fetch(image.src).then((response) => {
        //     return response.blob();
        // }).then(blob => {
        //     HttpgdViewer.downloadURL(URL.createObjectURL(blob), 'plot_'+this.navi.id()+'.svg');
        // });
    }

    private static imageTempCanvas(image: HTMLImageElement, fn: (canvas: HTMLCanvasElement) => void) {
        // const canvas = document.createElement('canvas');
        // document.body.appendChild(canvas);
        // const rect = image.getBoundingClientRect();
        // canvas.width = rect.width;
        // canvas.height = rect.height;
        // const ctx = canvas.getContext('2d');
        // if (!ctx) {return;}
        // ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        // fn(canvas);
        // document.body.removeChild(canvas);
    }

    public downloadPlotPNG(image: HTMLImageElement): void {
        if (!image) {return;}
        if (!this.navi.id()) {return;}
        HttpgdViewer.imageTempCanvas(image, canvas => {
            const imgURI = canvas
                .toDataURL('image/png')
                .replace('image/png', 'image/octet-stream');
            HttpgdViewer.downloadURL(imgURI, 'plot_'+this.navi.id()+'.png');
        });
    }

    public copyPlotPNG(image: HTMLImageElement): void {
        if (!image) {return;}
        if (!this.navi.id()) {return;}
        if (!navigator.clipboard) {return;}
        // HttpgdViewer.imageTempCanvas(image, canvas => {
        //     canvas.toBlob(blob => { 
        //         if (blob) 
        //             {navigator.clipboard.write?.([new ClipboardItem({ 'image/png': blob })]);} 
        //     });
        // });
        console.error('Copying plot currently disabled');
    }

    public checkResize(): void {
        // if (!this.image) {return;}
        // const rect = this.image.getBoundingClientRect();
        // this.navi.resize(rect.width * this.scale, rect.height * this.scale);
        // this.updateImage();
    }

    // this is called by window.addEventListener('resize', ...)
    private resizeBlocked: boolean = false;
    public resize(): void {
        if (this.resizeBlocked) {return;}
        this.resizeBlocked = true;
        setTimeout(() => {
            this.checkResize();
            this.resizeBlocked = false;
        }, HttpgdViewer.COOLDOWN_RESIZE);
    }
}