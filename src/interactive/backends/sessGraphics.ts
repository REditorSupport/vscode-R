import { spawn, ChildProcess, execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { JsonLines } from '../framing';
import { object } from '../protocol';
import { BackendEvent, ResizePlotRequest } from '../backend';
import { JgdSocketServer, JgdMessage } from '../../plotViewer/jgdSocketServer';
import { PlotHistory, PlotFrame } from '../../plotViewer/jgdPlotHistory';
import { plotToSvg } from '../plotSvg';
const run = promisify(execFile);

export class SessGraphics {
    enabled = false;
    private metrics?: ChildProcess;
    private jgd: JgdSocketServer;
    private history: PlotHistory;
    private metricPending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    private metricCounter = 0;
    private stopped = false;
    private plotContexts = new Map<string, string>();
    private pendingPlots = new Map<string, { frame: PlotFrame; count: number; device: string; plot: number; executionId?: string }>();
    private plotTimer?: NodeJS.Timeout;
    constructor(private config: { rPath: string; resources: string; plotBackend: string; historyLimit: number },
        private emit: (event: BackendEvent) => void) {
        this.history = new PlotHistory(config.historyLimit);
        this.jgd = new JgdSocketServer(this.history);
    }
    get endpoint(): string | undefined { return this.jgd.getSocketPath(); }
    resize(request: ResizePlotRequest): void {
        if (!this.enabled) { throw new Error('Live plot resizing is unavailable'); }
        this.jgd.sendToSession(request.device, { type: 'resize', plotIndex: request.plot, width: request.width, height: request.height });
    }
    dispose(): void {
        this.stopped = true; this.enabled = false;
        clearTimeout(this.plotTimer); this.pendingPlots.clear();
        this.metrics?.kill(); this.jgd.stop();
        for (const pending of this.metricPending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Graphics stopped')); }
        this.metricPending.clear();
    }
    async start(): Promise<void> {
        if (this.config.plotBackend === 'standard') { return; }
        try {
            const probe = await run(this.config.rPath, ['--vanilla', '--slave', '-e',
                'cat(requireNamespace("jgd",quietly=TRUE) && requireNamespace("systemfonts",quietly=TRUE))'], { timeout: 15000 });
            if (probe.stdout.trim() !== 'TRUE') {
                if (this.config.plotBackend === 'jgd') { throw new Error('JGD requires the jgd and systemfonts R packages'); }
                return;
            }
            this.metrics = spawn(this.config.rPath, ['--vanilla', '--slave', '-f', path.join(this.config.resources, 'interactive-metrics.R')], { stdio: ['pipe', 'pipe', 'pipe'] });
            const parser = new JsonLines(message => {
                const pending = this.metricPending.get(Number(message.id));
                if (!pending) { return; }
                clearTimeout(pending.timer); this.metricPending.delete(Number(message.id));
                if (message.type === 'metrics_error') { pending.reject(new Error(String(message.message))); }
                else { pending.resolve(message); }
            });
            this.metrics.stdout!.on('data', (chunk: Buffer) => { try { parser.push(chunk); } catch { this.metrics?.kill(); } });
            this.metrics.stderr!.on('data', (chunk: Buffer) => process.stderr.write(chunk));
            this.metrics.on('error', error => process.stderr.write(error.message + '\n'));
            this.jgd.setGetDimensions(() => ({ width: 800, height: 600 }));
            this.jgd.setMeasureText((request, dpi) => this.measure(request, dpi));
            this.jgd.setOnFrame((device, message) => {
                try { this.plot(device, message); }
                catch (error) { this.emit({ type: 'truncated', message: `Plot could not be retained: ${String(error)}` }); }
            });
            await new Promise<void>(resolve => { this.jgd.onReady(resolve); this.jgd.start(); });
            this.enabled = true;
        } catch (error) {
            if (this.config.plotBackend === 'jgd') { throw error; }
            this.dispose();
            this.emit({ type: 'warning', message: `JGD unavailable: ${String(error)}. Using static graphics.` });
        }
    }

    private measure(request: JgdMessage, dpi: number): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const id = this.metricCounter++;
            const timer = setTimeout(() => { this.metricPending.delete(id); reject(new Error('Font metrics timed out')); }, 2000);
            this.metricPending.set(id, { resolve: value => {
                resolve({ ...object(value), id: request.id });
            }, reject, timer });
            this.metrics?.stdin?.write(JSON.stringify({ ...request, id, dpi }) + '\n');
        });
    }

    private plot(device: string, message: JgdMessage): void {
        // A historical resize is a complete frame for that plot, not the device's
        // latest plot. Its context must not replace the live drawing context.
        const replay = message.resizeReplay === true;
        const frame = replay ? message.plot : this.history.latestPlot(device);
        if (!frame) { return; }
        const operations = (message.plot?.ops ?? []) as { op: string; ext?: { executionId?: string } }[];
        if (message.newPage && !replay) { this.plotContexts.delete(device); }
        let context = replay ? frame.frameExt?.executionId : this.plotContexts.get(device) ?? frame.frameExt?.executionId;
        let drawing = false;
        let drawingContext = context;
        for (const operation of operations) {
            if (operation.op === 'beginGroup' && operation.ext?.executionId) {
                context = operation.ext.executionId;
                if (!replay) { this.plotContexts.set(device, operation.ext.executionId); }
            } else if (!['clip', 'beginGroup', 'endGroup'].includes(operation.op)) { drawing = true; drawingContext = context; }
        }
        if (!drawing) { return; }
        const executionId = typeof drawingContext === 'string' && drawingContext ? drawingContext : undefined;
        const plot = frame.rIndex ?? message.plotNumber ?? 0;
        const displayId = `plot-${executionId ?? 'session'}-${device}-${plot}`;
        // JGD may emit hundreds of incremental frames for one ggplot. Keep only
        // the latest pending frame, preserving its operation boundary if another
        // cell later appends to the same device before this batch is flushed.
        this.pendingPlots.set(displayId, { frame: { ...frame }, count: frame.ops.length, device, plot, executionId });
        if (!this.plotTimer) { this.plotTimer = setTimeout(() => this.flush(), 200); }
    }

    flush(executionId?: string): void {
        if (this.stopped) { return; }
        if (!executionId) { clearTimeout(this.plotTimer); this.plotTimer = undefined; }
        for (const [displayId, pending] of this.pendingPlots) {
            if (executionId && pending.executionId !== executionId) { continue; }
            this.pendingPlots.delete(displayId);
            try {
                const { frame, count, device, plot } = pending;
                const svg = plotToSvg({ ...frame, ops: frame.ops.slice(0, count) });
                this.emit({ type: 'display', executionId: pending.executionId, data: { kind: 'plot', displayId, svg, device, plot,
                    width: frame.device.width, height: frame.device.height } });
            } catch (error) { this.emit({ type: 'truncated', executionId: pending.executionId, message: `Plot could not be retained: ${String(error)}` }); }
        }
    }

}
