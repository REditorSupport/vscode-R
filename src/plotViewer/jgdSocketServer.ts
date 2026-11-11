import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { PlotHistory, PlotFrame } from './jgdPlotHistory';
import { isViewerSessionSource, ViewerSessionSource } from '../viewerSession';
import { sessionProcessIdentity } from '../sessionIdentity';

const SERVER_NAME = 'jgd-vscode';

export type ConnectionChangeListener = (count: number, sessionId: string) => void;

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
    dpi: number;
    deviceClosed?: boolean;
    source?: ViewerSessionSource;
}

const isWindows = process.platform === 'win32';

export interface JgdMeasureText {
    (request: JgdMessage, dpi: number, sessionId: string): Promise<unknown>;
}

export interface JgdGetDimensions {
    (sessionId: string): { width: number; height: number } | null;
}

export class JgdSocketServer {
    private server: net.Server | null = null;
    private socketPath: string = '';
    private socketDir: string = '';
    private sessions: Map<string, RSession> = new Map();
    private connectionListeners: ConnectionChangeListener[] = [];
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

    handleResize(w: number, h: number, sessionId: string) {
        const idx = this.history.currentIndex(sessionId);
        const total = this.history.count(sessionId);
        if ((total > 0 && idx < total) || (total > 0 && this.history.isLatestDeleted(sessionId))) {
            const rIndex = this.history.currentRIndex(sessionId);
            if (rIndex !== undefined) {
                this.broadcastResize(w, h, rIndex, sessionId);
            }
        } else {
            this.broadcastResize(w, h, undefined, sessionId);
        }
    }

    isConnected(sessionId: string): boolean {
        const session = this.sessions.get(sessionId);
        return !!session && !session.deviceClosed;
    }

    private notifyConnectionChange(sessionId: string) {
        const count = this.sessions.size;
        for (const l of this.connectionListeners) {
            l(count, sessionId);
        }
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
            try {
                fs.chmodSync(this.socketDir, 0o700);
            } catch {
                /* ignore */
            }
            this.socketPath = path.join(this.socketDir, `${token}.sock`);
            try {
                fs.unlinkSync(this.socketPath);
            } catch {
                /* ignore */
            }

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
        for (const l of this.readyListeners) {
            l();
        }
    }

    stop() {
        for (const session of this.sessions.values()) {
            session.socket.destroy();
        }
        this.sessions.clear();
        this.server?.close();
        if (!isWindows) {
            try {
                fs.unlinkSync(this.socketPath);
            } catch {
                /* ignore */
            }
            if (this.socketDir) {
                try {
                    fs.rmSync(this.socketDir, { recursive: true, force: true });
                } catch {
                    /* ignore */
                }
                this.socketDir = '';
            }
        }
    }

    private handleConnection(socket: net.Socket) {
        // A new device must never acquire a restored device's replay indices.
        const sessionId = `session-${crypto.randomUUID()}`;
        // Metrics requests omit DPI. Use JGD's default until a frame announces
        // the device's resolution, then keep it specific to this connection.
        const session: RSession = {
            id: sessionId,
            socket,
            buffer: '',
            welcomeSent: false,
            lastResizeW: 0,
            lastResizeH: 0,
            lastResizeHadPlotIndex: false,
            dpi: 96,
        };
        this.sessions.set(sessionId, session);
        this.notifyConnectionChange(sessionId);

        socket.on('data', (data) => {
            session.buffer += data.toString();
            let newlineIdx: number;
            while ((newlineIdx = session.buffer.indexOf('\n')) !== -1) {
                const line = session.buffer.substring(0, newlineIdx);
                session.buffer = session.buffer.substring(newlineIdx + 1);
                if (line.length === 0) {
                    continue;
                }

                if (!session.welcomeSent) {
                    session.welcomeSent = true;
                    const welcome = {
                        type: 'server_info',
                        serverName: SERVER_NAME,
                        protocolVersion: 1,
                        transport: isWindows ? 'npipe' : 'unix',
                    };
                    socket.write(JSON.stringify(welcome) + '\n');

                    const dims = this.getDimensionsFn?.(sessionId);
                    if (dims) {
                        session.lastResizeW = dims.width;
                        session.lastResizeH = dims.height;
                        socket.write(
                            JSON.stringify({
                                type: 'resize',
                                width: dims.width,
                                height: dims.height,
                            }) + '\n',
                        );
                    }
                }

                this.handleMessage(session, line);
            }
        });

        socket.on('close', () => {
            if (this.sessions.get(session.id) === session) {
                this.sessions.delete(session.id);
                this.notifyConnectionChange(session.id);
            }
        });

        socket.on('error', (err) => {
            console.error(`jgd session ${sessionId} error:`, err.message);
            if (this.sessions.get(session.id) === session) {
                this.sessions.delete(session.id);
                this.notifyConnectionChange(session.id);
            }
        });
    }

    private handleMessage(session: RSession, line: string) {
        if (this.sessions.get(session.id) !== session) {
            return;
        }
        try {
            const msg = JSON.parse(line) as JgdMessage;
            switch (msg.type) {
                case 'frame': {
                    const plot = msg.plot;
                    if (plot) {
                        const identity = msg.ext?.vscodeR;
                        let restoring = false;
                        if (
                            isViewerSessionSource(identity) &&
                            'deviceId' in identity &&
                            typeof identity.deviceId === 'string' &&
                            identity.deviceId.length > 0 &&
                            identity.deviceId.length <= 256
                        ) {
                            const id = `session-${sessionProcessIdentity(identity)}:${identity.deviceId}`;
                            if (!session.source) {
                                this.sessions.delete(session.id);
                                this.sessions.get(id)?.socket.destroy();
                                session.id = id;
                                session.source = {
                                    sessionId: identity.sessionId,
                                    host: identity.host,
                                    pid: identity.pid,
                                    rVer: identity.rVer,
                                    processExited: false,
                                };
                                this.sessions.set(id, session);
                                // Historical R replay indices belong to the old
                                // physical device, not this replacement socket.
                                this.history.invalidateReplayIndices(id);
                            }
                            restoring =
                                session.id === id &&
                                'restoring' in identity &&
                                identity.restoring === true;
                        }
                        if (Number.isFinite(plot.device?.dpi) && plot.device.dpi > 0) {
                            session.dpi = plot.device.dpi;
                        }
                        const deviceLabel = plot.sessionId;
                        plot.sessionId = session.id;
                        plot.frameExt = msg.ext ?? null;

                        const isResizeReplay = !!msg.resizeReplay;
                        const plotIndex =
                            typeof msg.plotIndex === 'number' && Number.isFinite(msg.plotIndex)
                                ? msg.plotIndex
                                : undefined;

                        let accepted = true;
                        if (restoring) {
                            plot.rIndex = msg.plotNumber;
                            accepted = msg.incremental
                                ? this.history.appendOps(session.id, plot as PlotFrame)
                                : this.history.replaceLatest(session.id, plot as PlotFrame);
                        } else if (isResizeReplay && plotIndex !== undefined) {
                            accepted = this.history.replaceAtIndex(
                                session.id,
                                plotIndex,
                                plot as PlotFrame,
                            );
                        } else if (isResizeReplay) {
                            const plotNumber =
                                typeof msg.plotNumber === 'number' &&
                                Number.isFinite(msg.plotNumber)
                                    ? msg.plotNumber
                                    : undefined;
                            accepted = this.history.replaceLatest(
                                session.id,
                                plot as PlotFrame,
                                plotNumber,
                            );
                        } else if (msg.incremental) {
                            accepted = this.history.appendOps(session.id, plot as PlotFrame);
                        } else if (msg.newPage) {
                            if (
                                typeof msg.plotNumber === 'number' &&
                                Number.isFinite(msg.plotNumber)
                            ) {
                                plot.rIndex = msg.plotNumber;
                            }
                            this.history.addPlot(session.id, plot as PlotFrame);
                        } else {
                            accepted = this.history.replaceLatest(session.id, plot as PlotFrame);
                        }
                        if (accepted) {
                            if (session.source) {
                                this.history.setSessionSource(session.id, session.source);
                            }
                            if (typeof deviceLabel === 'string' && deviceLabel) {
                                this.history.setSessionLabel(session.id, deviceLabel);
                            }
                            this.onFrameFn?.(session.id, msg);
                        }
                    }
                    break;
                }

                case 'metrics_request':
                    if (this.measureTextFn) {
                        void this.measureTextFn(msg, session.dpi, session.id)
                            .then((response: unknown) => {
                                const resp = JSON.stringify(response) + '\n';
                                session.socket.write(resp);
                            })
                            .catch((error: unknown) => {
                                console.warn('jgd font measurement failed:', error);
                            });
                    }
                    break;

                case 'close':
                    console.log(`jgd: session ${session.id} device closed`);
                    session.deviceClosed = true;
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
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        if (!session || session.deviceClosed) {
            return;
        }
        if (plotIndex !== undefined) {
            session.lastResizeW = w;
            session.lastResizeH = h;
            session.lastResizeHadPlotIndex = true;
            const data = JSON.stringify({ type: 'resize', width: w, height: h, plotIndex }) + '\n';
            session.socket.write(data);
            return;
        }

        if (
            session.lastResizeW === w &&
            session.lastResizeH === h &&
            !session.lastResizeHadPlotIndex
        ) {
            return;
        }
        session.lastResizeHadPlotIndex = false;
        session.lastResizeW = w;
        session.lastResizeH = h;
        session.socket.write(JSON.stringify({ type: 'resize', width: w, height: h }) + '\n');
    }
}
