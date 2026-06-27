import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { PlotHistory, PlotFrame } from './jgdPlotHistory';

const SERVER_NAME = 'jgd-vscode';

export type ConnectionChangeListener = (count: number) => void;

export interface JgdMessage {
    type: string;
    plot?: PlotFrame & { sessionId?: string; frameExt?: Record<string, unknown> | null };
    ext?: Record<string, unknown> | null;
    resizeReplay?: boolean;
    plotIndex?: number;
    plotNumber?: number;
    incremental?: boolean;
    newPage?: boolean;
    id?: number;
    kind?: string;
    str?: string;
    c?: number;
    gc?: Record<string, unknown>;
}

interface RSession {
    id: string;
    socket: net.Socket;
    buffer: string;
    welcomeSent: boolean;
    lastResizeW: number;
    lastResizeH: number;
    lastResizeHadPlotIndex: boolean;
}

const isWindows = process.platform === 'win32';

export interface JgdMeasureText {
    (request: JgdMessage): Promise<unknown>;
}

export interface JgdGetDimensions {
    (): { width: number; height: number } | null;
}

export class JgdSocketServer {
    private server: net.Server | null = null;
    private socketPath: string = '';
    private socketDir: string = '';
    private sessions: Map<string, RSession> = new Map();
    private connectionListeners: ConnectionChangeListener[] = [];
    private sessionCounter = 0;
    private readyListeners: (() => void)[] = [];

    private resizeListener: ((w: number, h: number) => void) | null = null;
    private measureTextFn: JgdMeasureText | null = null;
    private getDimensionsFn: JgdGetDimensions | null = null;
    private onFrameFn: ((sessionId: string, msg: JgdMessage) => void) | null = null;
    private onDeviceClosedFn: ((sessionId: string) => void) | null = null;

    constructor(private history: PlotHistory) {}

    getSocketPath(): string {
        return this.socketPath;
    }

    getEnvVars(): Record<string, string> {
        return { JGD_SOCKET: this.getSocketPath() };
    }

    onReady(listener: () => void) {
        this.readyListeners.push(listener);
    }

    onConnectionChange(listener: ConnectionChangeListener) {
        this.connectionListeners.push(listener);
    }

    setResizeListener(listener: (w: number, h: number) => void) {
        this.resizeListener = listener;
    }

    setMeasureText(fn: JgdMeasureText) {
        this.measureTextFn = fn;
    }

    setGetDimensions(fn: JgdGetDimensions) {
        this.getDimensionsFn = fn;
    }

    setOnFrame(fn: (sessionId: string, msg: JgdMessage) => void) {
        this.onFrameFn = fn;
    }

    setOnDeviceClosed(fn: (sessionId: string) => void) {
        this.onDeviceClosedFn = fn;
    }

    handleResize(w: number, h: number) {
        const idx = this.history.currentIndex();
        const total = this.history.count();
        if ((total > 0 && idx < total) || (total > 0 && this.history.isLatestDeleted())) {
            const rIndex = this.history.currentRIndex();
            if (rIndex !== undefined) {
                const sessionId = this.history.getActiveSessionId();
                this.broadcastResize(w, h, rIndex, sessionId);
            } else {
                this.broadcastResize(w, h);
            }
        } else {
            this.broadcastResize(w, h);
        }
    }

    private notifyConnectionChange() {
        const count = this.sessions.size;
        for (const l of this.connectionListeners) l(count);
    }

    start() {
        this.server = net.createServer((socket) => this.handleConnection(socket));

        const token = crypto.randomBytes(8).toString('hex');
        if (isWindows) {
            const pipeName = `jgd-${token}`;
            const pipePath = `\\\\.\\pipe\\${pipeName}`;
            this.socketPath = `npipe:////./pipe/${pipeName}`;
            this.server.listen(pipePath, () => {
                console.log('jgd: named pipe server listening at', pipePath);
                this.notifyReady();
            });
        } else {
            // Place the socket in a private 0o700 directory so other local
            // users cannot connect to it (mirrors the IPC pipe handling in #1705).
            this.socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jgd-'));
            try { fs.chmodSync(this.socketDir, 0o700); } catch { /* ignore */ }
            this.socketPath = path.join(this.socketDir, `${token}.sock`);
            try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }

            this.server.listen(this.socketPath, () => {
                console.log('jgd: socket server listening at', this.socketPath);
                this.notifyReady();
            });
        }

        this.server.on('error', (err) => {
            console.error('jgd socket server error:', err);
        });
    }

    private notifyReady() {
        for (const l of this.readyListeners) l();
    }

    stop() {
        for (const session of this.sessions.values()) {
            session.socket.destroy();
        }
        this.sessions.clear();
        this.server?.close();
        if (!isWindows) {
            try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
            if (this.socketDir) {
                try { fs.rmSync(this.socketDir, { recursive: true, force: true }); } catch { /* ignore */ }
                this.socketDir = '';
            }
        }
    }

    private handleConnection(socket: net.Socket) {
        const sessionId = `session-${++this.sessionCounter}`;
        const session: RSession = {
            id: sessionId, socket, buffer: '', welcomeSent: false,
            lastResizeW: 0, lastResizeH: 0, lastResizeHadPlotIndex: false
        };
        this.sessions.set(sessionId, session);
        this.notifyConnectionChange();

        socket.on('data', (data) => {
            session.buffer += data.toString();
            let newlineIdx: number;
            while ((newlineIdx = session.buffer.indexOf('\n')) !== -1) {
                const line = session.buffer.substring(0, newlineIdx);
                session.buffer = session.buffer.substring(newlineIdx + 1);
                if (line.length === 0) continue;

                if (!session.welcomeSent) {
                    session.welcomeSent = true;
                    const welcome = {
                        type: 'server_info',
                        serverName: SERVER_NAME,
                        protocolVersion: 1,
                        transport: isWindows ? 'npipe' : 'unix',
                    };
                    socket.write(JSON.stringify(welcome) + '\n');

                    const dims = this.getDimensionsFn?.();
                    if (dims) {
                        session.lastResizeW = dims.width;
                        session.lastResizeH = dims.height;
                        socket.write(JSON.stringify({ type: 'resize', width: dims.width, height: dims.height }) + '\n');
                    }
                }

                this.handleMessage(session, line);
            }
        });

        socket.on('close', () => {
            this.sessions.delete(sessionId);
            this.notifyConnectionChange();
        });

        socket.on('error', (err) => {
            console.error(`jgd session ${sessionId} error:`, err.message);
            this.sessions.delete(sessionId);
            this.notifyConnectionChange();
        });
    }

    private handleMessage(session: RSession, line: string) {
        try {
            const msg = JSON.parse(line) as JgdMessage;
            switch (msg.type) {
                case 'frame': {
                    const plot = msg.plot;
                    if (plot) {
                        plot.sessionId = session.id;
                        plot.frameExt = msg.ext ?? null;

                        const isResizeReplay = !!msg.resizeReplay;
                        const plotIndex = (typeof msg.plotIndex === 'number' && Number.isFinite(msg.plotIndex)) ? msg.plotIndex : undefined;

                        let accepted = true;
                        if (isResizeReplay && plotIndex !== undefined) {
                            accepted = this.history.replaceAtIndex(session.id, plotIndex, plot as PlotFrame);
                        } else if (isResizeReplay) {
                            const plotNumber = (typeof msg.plotNumber === 'number' && Number.isFinite(msg.plotNumber)) ? msg.plotNumber : undefined;
                            accepted = this.history.replaceLatest(session.id, plot as PlotFrame, plotNumber);
                        } else if (msg.incremental) {
                            accepted = this.history.appendOps(session.id, plot as PlotFrame);
                        } else if (msg.newPage) {
                            if (typeof msg.plotNumber === 'number' && Number.isFinite(msg.plotNumber)) {
                                plot.rIndex = msg.plotNumber;
                            }
                            this.history.addPlot(session.id, plot as PlotFrame);
                        } else {
                            this.history.replaceLatest(session.id, plot as PlotFrame);
                        }
                        if (accepted) {
                            this.onFrameFn?.(session.id, msg);
                        }
                    }
                    break;
                }

                case 'metrics_request':
                    if (this.measureTextFn) {
                        void this.measureTextFn(msg).then((response: unknown) => {
                            const resp = JSON.stringify(response) + '\n';
                            session.socket.write(resp);
                        });
                    }
                    break;

                case 'close':
                    console.log(`jgd: session ${session.id} device closed`);
                    this.onDeviceClosedFn?.(session.id);
                    break;

                default:
                    break;
            }
        } catch (e) {
            console.error('jgd: failed to parse message:', e);
        }
    }

    sendToSession(sessionId: string, msg: object) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.socket.write(JSON.stringify(msg) + '\n');
        }
    }

    private broadcastResize(w: number, h: number, plotIndex?: number, sessionId?: string) {
        if (plotIndex !== undefined) {
            if (!sessionId) return;
            const session = this.sessions.get(sessionId);
            if (!session) return;
            session.lastResizeW = w;
            session.lastResizeH = h;
            session.lastResizeHadPlotIndex = true;
            const data = JSON.stringify({ type: 'resize', width: w, height: h, plotIndex }) + '\n';
            session.socket.write(data);
            return;
        }

        const data = JSON.stringify({ type: 'resize', width: w, height: h }) + '\n';
        for (const session of this.sessions.values()) {
            if (session.lastResizeW === w && session.lastResizeH === h) {
                if (!session.lastResizeHadPlotIndex) continue;
            }
            session.lastResizeHadPlotIndex = false;
            session.lastResizeW = w;
            session.lastResizeH = h;
            session.socket.write(data);
        }
    }
}
