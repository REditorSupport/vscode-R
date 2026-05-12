import * as vscode from 'vscode';
import { PlotViewer } from './types';
import { PlotHistory, PlotFrame } from './jgdPlotHistory';
import { JgdSocketServer, JgdMessage } from './jgdSocketServer';
import { config } from '../util';

interface MetricsRequest {
    id: number;
    kind: string;
    str?: string;
    c?: number;
    gc?: {
        font?: {
            size?: number;
            family?: string;
            face?: number;
        };
    };
}

interface MetricsResponse {
    type: 'metrics_response';
    id: number;
    width: number;
    ascent: number;
    descent: number;
}

interface MetricsCacheEntry {
    width: number;
    ascent: number;
    descent: number;
}

interface WebviewMetricsResponse {
    type: 'metrics_response';
    id: number;
    originalId: number;
    width: number;
    ascent: number;
    descent: number;
}

interface WebviewMetricsWarmupEntry {
    key: string;
    width: number;
    ascent: number;
    descent: number;
}

interface WebviewMetricsWarmup {
    type: 'metrics_warmup';
    entries: WebviewMetricsWarmupEntry[];
}

interface WebviewExportData {
    type: 'export_data';
    format: string;
    data: string;
}

interface WebviewResize {
    type: 'resize';
    width: number;
    height: number;
}

interface WebviewNavigate {
    type: 'navigate';
    direction: string;
}

interface WebviewRequestExport {
    type: 'requestExport';
    format: 'png' | 'svg';
}

interface WebviewDeleteCurrent {
    type: 'deleteCurrent';
}

type WebviewMessage =
    | WebviewMetricsResponse
    | WebviewMetricsWarmup
    | WebviewExportData
    | WebviewResize
    | WebviewNavigate
    | WebviewRequestExport
    | WebviewDeleteCurrent;

export class JgdManager {
    public server: JgdSocketServer;
    public history: PlotHistory;
    private viewer: JgdViewer | null = null;
    private extensionUri: vscode.Uri | null = null;
    private historyChangeDisposable: { dispose(): void } | null = null;

    constructor() {
        const maxPlots = config().get<number>('plot.jgd.historyLimit', 50);
        this.history = new PlotHistory(maxPlots);
        this.server = new JgdSocketServer(this.history);
    }

    initialize(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
    }

    start() {
        this.server.setOnFrame((_sessionId, msg: JgdMessage) => {
            const current = this.history.currentPlot();
            if (current) {
                this.getOrCreateViewer().showPlot(current);
            } else if (msg.plot) {
                this.getOrCreateViewer().showPlot(msg.plot as PlotFrame);
            }
        });

        this.server.setOnDeviceClosed((_sessionId) => {
            this.viewer?.updateToolbar();
        });

        this.server.setMeasureText((request: JgdMessage) => {
            return this.getOrCreateViewer().measureText(request as unknown as MetricsRequest);
        });

        this.server.setGetDimensions(() => {
            return this.viewer?.getPanelDimensions() ?? null;
        });

        this.server.start();

        this.historyChangeDisposable = this.history.onDidChange(() => {
            void vscode.commands.executeCommand('setContext', 'r.plot.canGoBack',
                this.history.currentIndex() > 1);
            void vscode.commands.executeCommand('setContext', 'r.plot.canGoForward',
                this.history.currentIndex() < this.history.count());
        });
    }

    stop() {
        this.server.stop();
        this.historyChangeDisposable?.dispose();
        this.viewer?.dispose();
        this.viewer = null;
    }

    getViewer(): JgdViewer | null {
        return this.viewer;
    }

    getEnvVars(): Record<string, string> {
        return this.server.getEnvVars();
    }

    private getOrCreateViewer(): JgdViewer {
        if (!this.viewer) {
            this.viewer = new JgdViewer(this.extensionUri!, this.history, this.server);
        }
        return this.viewer;
    }
}

export class JgdViewer implements PlotViewer {
    readonly id = 'jgd';
    private panel: vscode.WebviewPanel | null = null;
    private pendingMetrics: Map<number, (response: MetricsResponse) => void> = new Map();
    private metricsIdCounter = 0;
    private metricsCache: Map<string, MetricsCacheEntry> = new Map();
    private panelWidth = 800;
    private panelHeight = 600;

    constructor(
        private extensionUri: vscode.Uri,
        private history: PlotHistory,
        private server: JgdSocketServer,
    ) {}

    show(preserveFocus?: boolean): void {
        if (this.panel) {
            this.panel.reveal(undefined, preserveFocus);
        } else {
            this.createPanel(preserveFocus);
        }
        const plot = this.history.currentPlot();
        if (plot) this.sendPlotToWebview(plot);
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = null;
    }

    async handleCommand(command: string, ...args: unknown[]): Promise<void> {
        switch (command) {
            case 'showViewers':
                this.show(true);
                break;
            case 'nextPlot': {
                const plot = this.history.navigateNext();
                if (plot) {
                    this.sendPlotToWebview(plot);
                    this.updateToolbar();
                    if (plot.device.width !== this.panelWidth || plot.device.height !== this.panelHeight) {
                        this.server.handleResize(this.panelWidth, this.panelHeight);
                    }
                }
                break;
            }
            case 'prevPlot': {
                const plot = this.history.navigatePrevious();
                if (plot) {
                    this.sendPlotToWebview(plot);
                    this.updateToolbar();
                    if (plot.device.width !== this.panelWidth || plot.device.height !== this.panelHeight) {
                        this.server.handleResize(this.panelWidth, this.panelHeight);
                    }
                }
                break;
            }
            case 'firstPlot': {
                let plot = this.history.navigatePrevious();
                while (plot) {
                    const prev = this.history.navigatePrevious();
                    if (!prev) break;
                    plot = prev;
                }
                if (plot) {
                    this.sendPlotToWebview(plot);
                    this.updateToolbar();
                    this.server.handleResize(this.panelWidth, this.panelHeight);
                }
                break;
            }
            case 'lastPlot': {
                let plot = this.history.navigateNext();
                while (plot) {
                    const next = this.history.navigateNext();
                    if (!next) break;
                    plot = next;
                }
                if (plot) {
                    this.sendPlotToWebview(plot);
                    this.updateToolbar();
                    this.server.handleResize(this.panelWidth, this.panelHeight);
                }
                break;
            }
            case 'exportPlot': {
                if (!this.panel) return;
                const format = (args[0] as string) || 'png';
                await this.handleExportRequest(format as 'png' | 'svg');
                break;
            }
            case 'closePlot':
            case 'hidePlot': {
                const plot = this.history.removeCurrent();
                if (plot) {
                    this.sendPlotToWebview(plot);
                } else {
                    void this.panel?.webview.postMessage({ type: 'clear' });
                }
                this.updateToolbar();
                break;
            }
            case 'resetPlots':
                this.history.clear();
                void this.panel?.webview.postMessage({ type: 'clear' });
                this.updateToolbar();
                break;
            // httpgd-specific commands — no-op for JGD
            case 'toggleStyle':
            case 'togglePreviewPlots':
            case 'openUrl':
            case 'openExternal':
            case 'zoomIn':
            case 'zoomOut':
            case 'toggleFullWindow':
            case 'showIndex':
                break;
        }
    }

    showPlot(plot: PlotFrame) {
        if (!this.panel) this.createPanel(true);
        this.sendPlotToWebview(plot);
        this.updateToolbar();
    }

    updateToolbar() {
        void this.panel?.webview.postMessage({
            type: 'toolbar',
            current: this.history.currentIndex(),
            total: this.history.count()
        });
    }

    getPanelDimensions(): { width: number; height: number } {
        return { width: this.panelWidth, height: this.panelHeight };
    }

    private canonicalizeFamily(family: string | undefined): string {
        if (!family || family === '' || family === 'sans') return 'sans-serif';
        if (family === 'serif' || family === 'Times') return 'serif';
        if (family === 'mono' || family === 'Courier') return 'monospace';
        return family;
    }

    async measureText(request: MetricsRequest): Promise<MetricsResponse> {
        if (!this.panel) {
            return { type: 'metrics_response', id: request.id, width: 0, ascent: 0, descent: 0 };
        }

        const gc = request.gc ?? {};
        const font = gc.font ?? {};
        const canonical = this.canonicalizeFamily(font.family);
        const fontSize = font.size ?? 12;
        const fontFace = font.face ?? 1;
        const fontKey = `${fontSize}|${canonical}|${fontFace}`;
        const cacheKey = `${request.kind}|${request.str ?? ''}|${request.c ?? 0}|${fontKey}`;
        const cached = this.metricsCache.get(cacheKey);
        if (cached) {
            return { type: 'metrics_response', id: request.id, ...cached };
        }

        if (request.kind === 'strWidth' && request.str) {
            const baseFontKey = `12|${canonical}|${fontFace}`;
            const scale = fontSize / 12;
            let total = 0;
            let allCached = true;
            for (const ch of request.str) {
                const cp = ch.codePointAt(0)!;
                const exactKey = `metricInfo||${cp}|${fontKey}`;
                const exactCached = this.metricsCache.get(exactKey);
                if (exactCached) {
                    total += exactCached.width;
                } else {
                    const baseKey = `metricInfo||${cp}|${baseFontKey}`;
                    const baseCached = this.metricsCache.get(baseKey);
                    if (baseCached) {
                        total += baseCached.width * scale;
                    } else {
                        allCached = false;
                        break;
                    }
                }
            }
            if (allCached) {
                const result: MetricsCacheEntry = { width: total, ascent: 0, descent: 0 };
                this.metricsCache.set(cacheKey, result);
                return { type: 'metrics_response', id: request.id, ...result };
            }
        }

        if (request.kind === 'metricInfo' && request.c) {
            const baseFontKey = `12|${canonical}|${fontFace}`;
            const scale = fontSize / 12;
            const baseKey = `metricInfo||${request.c}|${baseFontKey}`;
            const baseCached = this.metricsCache.get(baseKey);
            if (baseCached) {
                const result: MetricsCacheEntry = {
                    width: baseCached.width * scale,
                    ascent: baseCached.ascent * scale,
                    descent: baseCached.descent * scale
                };
                this.metricsCache.set(cacheKey, result);
                return { type: 'metrics_response', id: request.id, ...result };
            }
        }

        return this.roundTripMetrics(request, cacheKey);
    }

    private roundTripMetrics(request: MetricsRequest, cacheKey: string): Promise<MetricsResponse> {
        return new Promise((resolve) => {
            const id = ++this.metricsIdCounter;
            this.pendingMetrics.set(id, (response: MetricsResponse) => {
                this.metricsCache.set(cacheKey, { width: response.width, ascent: response.ascent, descent: response.descent });
                resolve(response);
            });
            void this.panel!.webview.postMessage({
                type: 'metrics_request',
                id,
                originalId: request.id,
                kind: request.kind,
                str: request.str,
                c: request.c,
                gc: request.gc
            });

            setTimeout(() => {
                if (this.pendingMetrics.has(id)) {
                    this.pendingMetrics.delete(id);
                    resolve({ type: 'metrics_response', id: request.id, width: 0, ascent: 0, descent: 0 });
                }
            }, 500);
        });
    }

    private createPanel(preserveFocus = false) {
        const viewColumnConfig = config().get<Record<string, string>>('session.viewers.viewColumn') ?? {};
        const plotColumn = viewColumnConfig['plot'] ?? 'Two';
        let viewColumn = vscode.ViewColumn.Two;
        if (plotColumn === 'Active') viewColumn = vscode.ViewColumn.Active;
        else if (plotColumn === 'Beside') viewColumn = vscode.ViewColumn.Beside;

        this.panel = vscode.window.createWebviewPanel(
            'jgd.plotPane',
            'R Plot (JGD)',
            { viewColumn, preserveFocus },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        this.panel.webview.html = this.getWebviewHtml();

        this.panel.webview.onDidReceiveMessage((raw: WebviewMessage) => {
            switch (raw.type) {
                case 'metrics_response': {
                    const resolver = this.pendingMetrics.get(raw.id);
                    if (resolver) {
                        this.pendingMetrics.delete(raw.id);
                        resolver({
                            type: 'metrics_response',
                            id: raw.originalId,
                            width: raw.width,
                            ascent: raw.ascent,
                            descent: raw.descent
                        });
                    }
                    break;
                }
                case 'metrics_warmup': {
                    if (raw.entries && Array.isArray(raw.entries)) {
                        for (const e of raw.entries) {
                            this.metricsCache.set(e.key, { width: e.width, ascent: e.ascent, descent: e.descent });
                        }
                    }
                    break;
                }
                case 'export_data': {
                    void this.handleExportData(raw);
                    break;
                }
                case 'resize': {
                    this.panelWidth = raw.width;
                    this.panelHeight = raw.height;
                    this.server.handleResize(raw.width, raw.height);
                    break;
                }
                case 'navigate': {
                    if (raw.direction === 'previous') {
                        void this.handleCommand('prevPlot');
                    } else if (raw.direction === 'next') {
                        void this.handleCommand('nextPlot');
                    }
                    break;
                }
                case 'requestExport': {
                    void this.handleExportRequest(raw.format);
                    break;
                }
                case 'deleteCurrent': {
                    void this.handleCommand('closePlot');
                    break;
                }
            }
        });

        this.panel.onDidDispose(() => {
            this.panel = null;
            this.metricsCache.clear();
        });
    }

    private async handleExportRequest(format: 'png' | 'svg') {
        const defaultW = config().get<number>('plot.jgd.exportWidth', 7);
        const defaultH = config().get<number>('plot.jgd.exportHeight', 7);
        const defaultDpi = config().get<number>('plot.jgd.exportDpi', 150);
        const input = await vscode.window.showInputBox({
            title: 'Export Plot',
            prompt: 'Width x height (inches) @ DPI',
            value: `${defaultW} x ${defaultH} @ ${defaultDpi}`,
            validateInput: (v) => {
                const m = v.match(/^\s*([\d.]+)\s*[x×,]\s*([\d.]+)\s*(?:@\s*(\d+))?\s*$/i);
                if (!m) return 'Enter as "7 x 5 @ 150" (inches @ DPI)';
                const w = parseFloat(m[1]), h = parseFloat(m[2]), dpi = parseInt(m[3] || '150');
                if (w < 0.5 || h < 0.5 || w > 50 || h > 50) return 'Dimensions must be 0.5–50 inches';
                if (dpi < 36 || dpi > 600) return 'DPI must be 36–600';
                return null;
            }
        });
        if (!input) return;
        const m = input.match(/^\s*([\d.]+)\s*[x×,]\s*([\d.]+)\s*(?:@\s*(\d+))?\s*$/i)!;
        const dpi = parseInt(m[3] || String(defaultDpi));
        const width = Math.round(parseFloat(m[1]) * dpi);
        const height = Math.round(parseFloat(m[2]) * dpi);
        void this.panel?.webview.postMessage({ type: 'export', format, width, height });
    }

    private sendPlotToWebview(plot: PlotFrame) {
        void this.panel?.webview.postMessage({ type: 'render', plot });
    }

    private async handleExportData(msg: WebviewExportData) {
        const filters: Record<string, string[]> = {
            png: ['PNG Image'],
            svg: ['SVG Image'],
        };
        const ext = msg.format;
        const uri = await vscode.window.showSaveDialog({
            filters: { [filters[ext]?.[0] ?? ext]: [ext] },
            defaultUri: vscode.Uri.file(`plot.${ext}`)
        });
        if (!uri) return;

        if (msg.data) {
            const buf = Buffer.from(msg.data, 'base64');
            await vscode.workspace.fs.writeFile(uri, buf);
            void vscode.window.showInformationMessage(`Plot exported to ${uri.fsPath}`);
        }
    }

    private getWebviewHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: var(--vscode-editor-background); overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
#toolbar {
    display: flex; align-items: center; gap: 8px; padding: 4px 8px;
    background: var(--vscode-editorWidget-background);
    border-bottom: 1px solid var(--vscode-editorWidget-border);
    font-size: 12px; color: var(--vscode-foreground);
}
#toolbar button {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; padding: 2px 8px; cursor: pointer; border-radius: 2px;
}
#toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
#toolbar button:disabled { opacity: 0.4; cursor: default; }
#plot-info { flex: 1; text-align: center; }
#canvas-container { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; }
canvas { display: block; }
</style>
</head>
<body>
<div id="toolbar">
    <button id="btn-prev" title="Previous plot">&#9664;</button>
    <button id="btn-next" title="Next plot">&#9654;</button>
    <button id="btn-delete" title="Remove current plot">&#10005;</button>
    <span id="plot-info">No plots</span>
    <select id="export-select">
        <option value="">Export…</option>
        <option value="png">PNG</option>
        <option value="svg">SVG</option>
    </select>
</div>
<div id="canvas-container">
    <canvas id="plot-canvas"></canvas>
</div>
<canvas id="metrics-canvas" style="display:none;"></canvas>
<script>
${getRendererScript()}
</script>
</body>
</html>`;
    }
}

function getRendererScript(): string {
    return `
const vscode = acquireVsCodeApi();
const canvas = document.getElementById('plot-canvas');
const ctx = canvas.getContext('2d');
const metricsCanvas = document.getElementById('metrics-canvas');
const metricsCtx = metricsCanvas.getContext('2d');

let currentPlot = null;

document.getElementById('btn-prev').addEventListener('click', () => {
    vscode.postMessage({ type: 'navigate', direction: 'previous' });
});
document.getElementById('btn-next').addEventListener('click', () => {
    vscode.postMessage({ type: 'navigate', direction: 'next' });
});
document.getElementById('export-select').addEventListener('change', (e) => {
    const fmt = e.target.value;
    if (fmt) {
        vscode.postMessage({ type: 'requestExport', format: fmt });
        e.target.value = '';
    }
});
document.getElementById('btn-delete').addEventListener('click', () => {
    vscode.postMessage({ type: 'deleteCurrent' });
});

const container = document.getElementById('canvas-container');
let resizeTimer = null;
let lastSentW = 0;
let lastSentH = 0;
const resizeObserver = new ResizeObserver(() => {
    if (currentPlot) replay(currentPlot);
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w !== lastSentW || h !== lastSentH) {
            lastSentW = w;
            lastSentH = h;
            vscode.postMessage({ type: 'resize', width: w, height: h });
        }
    }, 300);
});
resizeObserver.observe(container);

(function warmupMetrics() {
    const fonts = [
        { size: 12, family: 'sans-serif', face: 1 },
        { size: 12, family: 'serif', face: 1 },
        { size: 12, family: 'monospace', face: 1 },
        { size: 12, family: 'sans-serif', face: 2 },
        { size: 10, family: 'sans-serif', face: 1 },
        { size: 14, family: 'sans-serif', face: 1 },
    ];
    const entries = [];
    for (const f of fonts) {
        let style = '';
        if (f.face === 2 || f.face === 4) style += 'bold ';
        if (f.face === 3 || f.face === 4) style += 'italic ';
        metricsCtx.font = style + f.size + 'px ' + f.family;
        const fontKey = f.size + '|' + f.family + '|' + f.face;
        for (let c = 32; c <= 126; c++) {
            const ch = String.fromCodePoint(c);
            const m = metricsCtx.measureText(ch);
            entries.push({
                key: 'metricInfo||' + c + '|' + fontKey,
                width: m.width,
                ascent: m.actualBoundingBoxAscent || f.size * 0.75,
                descent: m.actualBoundingBoxDescent || f.size * 0.25
            });
        }
    }
    vscode.postMessage({ type: 'metrics_warmup', entries });
})();

window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
        case 'render':
            currentPlot = msg.plot;
            replay(msg.plot);
            break;
        case 'clear':
            currentPlot = null;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            break;
        case 'toolbar':
            document.getElementById('plot-info').textContent =
                msg.total > 0 ? msg.current + ' / ' + msg.total : 'No plots';
            document.getElementById('btn-prev').disabled = msg.current <= 1;
            document.getElementById('btn-next').disabled = msg.current >= msg.total;
            document.getElementById('btn-delete').disabled = msg.total === 0;
            break;
        case 'metrics_request':
            handleMetricsRequest(msg);
            break;
        case 'export':
            handleExport(msg.format, msg.width, msg.height);
            break;
    }
});

function applyGc(ctx, gc) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.filter = 'none';
    if (!gc) return;
    if (gc.col != null) ctx.strokeStyle = gc.col;
    if (gc.fill != null) ctx.fillStyle = gc.fill;
    ctx.lineWidth = gc.lwd || 1;
    ctx.lineCap = gc.lend || 'round';
    ctx.lineJoin = gc.ljoin || 'round';
    ctx.miterLimit = gc.lmitre || 10;
    if (gc.lty && gc.lty.length > 0) {
        ctx.setLineDash(gc.lty);
    } else {
        ctx.setLineDash([]);
    }
    if (gc.font) {
        const size = gc.font.size || 12;
        const family = mapFontFamily(gc.font.family);
        const face = gc.font.face || 1;
        let style = '';
        if (face === 2 || face === 4) style += 'bold ';
        if (face === 3 || face === 4) style += 'italic ';
        ctx.font = style + size + 'px ' + family;
    }
    if (gc.ext) {
        if (gc.ext.blendMode != null) ctx.globalCompositeOperation = gc.ext.blendMode;
        if (gc.ext.opacity != null) ctx.globalAlpha = gc.ext.opacity;
        if (gc.ext.shadow) {
            if (gc.ext.shadow.blur != null) ctx.shadowBlur = gc.ext.shadow.blur;
            if (gc.ext.shadow.color != null) ctx.shadowColor = gc.ext.shadow.color;
            if (gc.ext.shadow.offsetX != null) ctx.shadowOffsetX = gc.ext.shadow.offsetX;
            if (gc.ext.shadow.offsetY != null) ctx.shadowOffsetY = gc.ext.shadow.offsetY;
        }
        if (gc.ext.filter != null && isSafeCssFilter(gc.ext.filter)) ctx.filter = gc.ext.filter;
    }
}

function mapFontFamily(family) {
    if (!family || family === '' || family === 'sans') return 'sans-serif';
    if (family === 'serif' || family === 'Times') return 'serif';
    if (family === 'mono' || family === 'Courier') return 'monospace';
    return family + ', sans-serif';
}

function makeRenderCtx() {
    return { groupStack: [], currentClip: null };
}

function effectToFilter(effect) {
    switch (effect.type) {
        case 'blur': return 'blur(' + (effect.radius || 0) + 'px)';
        case 'brightness': return 'brightness(' + (effect.value || 1) + ')';
        case 'contrast': return 'contrast(' + (effect.value || 1) + ')';
        case 'grayscale': return 'grayscale(' + (effect.value || 1) + ')';
        case 'saturate': return 'saturate(' + (effect.value || 1) + ')';
        case 'sepia': return 'sepia(' + (effect.value || 1) + ')';
        case 'hue-rotate': return 'hue-rotate(' + (effect.angle || 0) + 'deg)';
        case 'invert': return 'invert(' + (effect.value || 1) + ')';
        default: return effect.filter || '';
    }
}

function applyGlowEffect(ctx, effect) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const origCanvas = document.createElement('canvas');
    origCanvas.width = w;
    origCanvas.height = h;
    const origCtx = origCanvas.getContext('2d');
    if (!origCtx) return;
    origCtx.drawImage(ctx.canvas, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.filter = 'blur(' + (effect.radius || 3) + 'px) brightness(' + (effect.brightness || 1.5) + ')';
    ctx.drawImage(origCanvas, 0, 0);
    ctx.filter = 'none';
    ctx.drawImage(origCanvas, 0, 0);
    ctx.restore();
}

function applyPostEffects(ctx, effects) {
    for (let i = 0; i < effects.length; i++) {
        const effect = effects[i];
        if (effect.type === 'glow') {
            applyGlowEffect(ctx, effect);
            continue;
        }
        const filterStr = effectToFilter(effect);
        if (!filterStr || !isSafeCssFilter(filterStr)) continue;
        const w = ctx.canvas.width;
        const h = ctx.canvas.height;
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = w;
        tmpCanvas.height = h;
        const tmpCtx = tmpCanvas.getContext('2d');
        if (!tmpCtx) continue;
        tmpCtx.drawImage(ctx.canvas, 0, 0);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.filter = filterStr;
        ctx.drawImage(tmpCanvas, 0, 0);
        ctx.restore();
    }
}

let replayGeneration = 0;
let replayChain = Promise.resolve();

async function replay(plot) {
    const gen = ++replayGeneration;
    const run = () => doReplay(plot, gen);
    replayChain = replayChain.then(run, run);
    await replayChain;
}

async function doReplay(plot, gen) {
    if (replayGeneration !== gen) return;

    const dpr = window.devicePixelRatio || 1;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;

    if (containerW <= 0 || containerH <= 0) return;

    const plotW = plot.device.width;
    const plotH = plot.device.height;
    const scaleX = containerW / plotW;
    const scaleY = containerH / plotH;
    const scale = Math.min(scaleX, scaleY);

    const drawW = plotW * scale;
    const drawH = plotH * scale;

    canvas.width = drawW * dpr;
    canvas.height = drawH * dpr;
    canvas.style.width = drawW + 'px';
    canvas.style.height = drawH + 'px';

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr * scale, dpr * scale);

    ctx.save();
    try {
        if (plot.device.bg) {
            ctx.fillStyle = plot.device.bg;
            ctx.fillRect(0, 0, plotW, plotH);
        } else {
            ctx.clearRect(0, 0, plotW, plotH);
        }

        const ops = plot.ops;
        const rc = makeRenderCtx();
        for (let i = 0; i < ops.length; i++) {
            if (replayGeneration !== gen) return;
            const currentCtx = rc.groupStack.length > 0 ? rc.groupStack[rc.groupStack.length - 1].ctx : ctx;
            await renderOp(currentCtx, ops[i], plotH, rc);
            if (replayGeneration !== gen) return;
        }

        if (plot.frameExt && plot.frameExt.postEffects) {
            ctx.restore();
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
            ctx.shadowBlur = 0;
            ctx.shadowColor = 'transparent';
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
            ctx.filter = 'none';
            applyPostEffects(ctx, plot.frameExt.postEffects);
            ctx.save();
        }
    } finally {
        ctx.restore();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
}

async function renderOp(ctx, op, plotH, rc) {
    switch (op.op) {
        case 'line': {
            applyGc(ctx, op.gc);
            if (op.gc && op.gc.col != null) {
                ctx.beginPath();
                ctx.moveTo(op.x1, op.y1);
                ctx.lineTo(op.x2, op.y2);
                ctx.stroke();
            }
            break;
        }
        case 'polyline': {
            applyGc(ctx, op.gc);
            if (op.x.length < 2) break;
            ctx.beginPath();
            ctx.moveTo(op.x[0], op.y[0]);
            for (let i = 1; i < op.x.length; i++) {
                ctx.lineTo(op.x[i], op.y[i]);
            }
            if (op.gc && op.gc.col != null) ctx.stroke();
            break;
        }
        case 'polygon': {
            applyGc(ctx, op.gc);
            ctx.beginPath();
            ctx.moveTo(op.x[0], op.y[0]);
            for (let i = 1; i < op.x.length; i++) {
                ctx.lineTo(op.x[i], op.y[i]);
            }
            ctx.closePath();
            if (op.gc && op.gc.fill != null) ctx.fill();
            if (op.gc && op.gc.col != null) ctx.stroke();
            break;
        }
        case 'rect': {
            applyGc(ctx, op.gc);
            const rx = Math.min(op.x0, op.x1);
            const ry = Math.min(op.y0, op.y1);
            const rw = Math.abs(op.x1 - op.x0);
            const rh = Math.abs(op.y1 - op.y0);
            if (op.gc && op.gc.fill != null) {
                ctx.fillStyle = op.gc.fill;
                ctx.fillRect(rx, ry, rw, rh);
            }
            if (op.gc && op.gc.col != null) {
                ctx.strokeStyle = op.gc.col;
                ctx.strokeRect(rx, ry, rw, rh);
            }
            break;
        }
        case 'circle': {
            applyGc(ctx, op.gc);
            ctx.beginPath();
            ctx.arc(op.x, op.y, op.r, 0, 2 * Math.PI);
            if (op.gc && op.gc.fill != null) ctx.fill();
            if (op.gc && op.gc.col != null) ctx.stroke();
            break;
        }
        case 'text': {
            applyGc(ctx, op.gc);
            ctx.save();
            ctx.translate(op.x, op.y);
            if (op.rot) ctx.rotate(-op.rot * Math.PI / 180);
            ctx.textBaseline = 'alphabetic';
            let align = 'left';
            if (op.hadj === 0.5) align = 'center';
            else if (op.hadj === 1) align = 'right';
            ctx.textAlign = align;
            if (op.gc && op.gc.col != null) {
                ctx.fillStyle = op.gc.col;
                ctx.fillText(op.str, 0, 0);
            }
            ctx.restore();
            break;
        }
        case 'clip': {
            const clipRect = { x0: op.x0, y0: op.y0, x1: op.x1, y1: op.y1 };
            if (rc.groupStack.length > 0) {
                rc.groupStack[rc.groupStack.length - 1].clip = clipRect;
            } else {
                rc.currentClip = clipRect;
            }
            ctx.restore();
            ctx.save();
            ctx.beginPath();
            ctx.rect(op.x0, op.y0, op.x1 - op.x0, op.y1 - op.y0);
            ctx.clip();
            break;
        }
        case 'beginGroup': {
            const groupCanvas = document.createElement('canvas');
            groupCanvas.width = ctx.canvas.width;
            groupCanvas.height = ctx.canvas.height;
            const groupCtx = groupCanvas.getContext('2d');
            if (!groupCtx) break;
            groupCtx.setTransform(ctx.getTransform());
            groupCtx.save();
            let activeClip = rc.currentClip;
            for (let gi = rc.groupStack.length - 1; gi >= 0; gi--) {
                if (rc.groupStack[gi].clip) { activeClip = rc.groupStack[gi].clip; break; }
            }
            if (activeClip) {
                groupCtx.beginPath();
                groupCtx.rect(activeClip.x0, activeClip.y0,
                              activeClip.x1 - activeClip.x0,
                              activeClip.y1 - activeClip.y0);
                groupCtx.clip();
            }
            rc.groupStack.push({
                parentCtx: ctx,
                ctx: groupCtx,
                canvas: groupCanvas,
                ext: op.ext || null,
                clip: null
            });
            break;
        }
        case 'endGroup': {
            if (rc.groupStack.length === 0) break;
            const group = rc.groupStack.pop();
            const parentCtx = group.parentCtx;
            parentCtx.save();
            if (group.ext) {
                if (group.ext.filter != null && isSafeCssFilter(group.ext.filter)) parentCtx.filter = group.ext.filter;
                if (group.ext.opacity != null) parentCtx.globalAlpha = group.ext.opacity;
                if (group.ext.blendMode != null) parentCtx.globalCompositeOperation = group.ext.blendMode;
                if (group.ext.shadow) {
                    if (group.ext.shadow.blur != null) parentCtx.shadowBlur = group.ext.shadow.blur;
                    if (group.ext.shadow.color != null) parentCtx.shadowColor = group.ext.shadow.color;
                    if (group.ext.shadow.offsetX != null) parentCtx.shadowOffsetX = group.ext.shadow.offsetX;
                    if (group.ext.shadow.offsetY != null) parentCtx.shadowOffsetY = group.ext.shadow.offsetY;
                }
            }
            parentCtx.setTransform(1, 0, 0, 1, 0, 0);
            parentCtx.drawImage(group.canvas, 0, 0);
            parentCtx.restore();
            break;
        }
        case 'path': {
            applyGc(ctx, op.gc);
            ctx.beginPath();
            for (const subpath of op.subpaths) {
                if (subpath.length === 0) continue;
                ctx.moveTo(subpath[0][0], subpath[0][1]);
                for (let i = 1; i < subpath.length; i++) {
                    ctx.lineTo(subpath[i][0], subpath[i][1]);
                }
                ctx.closePath();
            }
            const rule = op.winding === 'evenodd' ? 'evenodd' : 'nonzero';
            if (op.gc && op.gc.fill != null) ctx.fill(rule);
            if (op.gc && op.gc.col != null) ctx.stroke();
            break;
        }
        case 'raster': {
            const img = new Image();
            img.src = op.data;
            await img.decode();
            ctx.save();
            const dw = op.w;
            const dh = op.h;
            const aw = Math.abs(dw);
            const ah = Math.abs(dh);
            const dx = dw >= 0 ? op.x : op.x + dw;
            const dy = op.y - ah;
            if (op.rot) {
                const cx = dx + aw / 2;
                const cy = dy + ah / 2;
                ctx.translate(cx, cy);
                ctx.rotate(-op.rot * Math.PI / 180);
                ctx.translate(-cx, -cy);
            }
            ctx.imageSmoothingEnabled = !!op.interpolate;
            ctx.drawImage(img, dx, dy, aw, ah);
            ctx.restore();
            break;
        }
    }
}

function handleMetricsRequest(msg) {
    const gc = msg.gc || {};
    const size = gc.font ? gc.font.size || 12 : 12;
    const family = gc.font ? mapFontFamily(gc.font.family) : 'sans-serif';
    const face = gc.font ? gc.font.face || 1 : 1;
    let style = '';
    if (face === 2 || face === 4) style += 'bold ';
    if (face === 3 || face === 4) style += 'italic ';
    metricsCtx.font = style + size + 'px ' + family;

    let width = 0, ascent = 0, descent = 0;
    if (msg.kind === 'strWidth' && msg.str) {
        const m = metricsCtx.measureText(msg.str);
        width = m.width;
    } else if (msg.kind === 'metricInfo') {
        const ch = msg.c > 0 ? String.fromCodePoint(msg.c) : 'M';
        const m = metricsCtx.measureText(ch);
        width = m.width;
        ascent = m.actualBoundingBoxAscent || size * 0.75;
        descent = m.actualBoundingBoxDescent || size * 0.25;
    }

    vscode.postMessage({
        type: 'metrics_response',
        id: msg.id,
        originalId: msg.originalId,
        width, ascent, descent
    });
}

function handleExport(format, exportW, exportH) {
    if (!currentPlot) return;
    if (format === 'png') {
        const offscreen = document.createElement('canvas');
        const plotW = currentPlot.device.width;
        const plotH = currentPlot.device.height;
        const scale = Math.min(exportW / plotW, exportH / plotH);
        offscreen.width = plotW * scale;
        offscreen.height = plotH * scale;
        const offCtx = offscreen.getContext('2d');
        offCtx.scale(scale, scale);
        if (currentPlot.device.bg) {
            offCtx.fillStyle = currentPlot.device.bg;
            offCtx.fillRect(0, 0, plotW, plotH);
        }
        (async () => {
            const rc = makeRenderCtx();
            for (const op of currentPlot.ops) {
                const curCtx = rc.groupStack.length > 0 ? rc.groupStack[rc.groupStack.length - 1].ctx : offCtx;
                await renderOp(curCtx, op, plotH, rc);
            }
            let exportCanvas = offscreen;
            if (currentPlot.frameExt && currentPlot.frameExt.postEffects) {
                const postCanvas = document.createElement('canvas');
                postCanvas.width = offscreen.width;
                postCanvas.height = offscreen.height;
                const postCtx = postCanvas.getContext('2d');
                if (postCtx) {
                    postCtx.drawImage(offscreen, 0, 0);
                    applyPostEffects(postCtx, currentPlot.frameExt.postEffects);
                    exportCanvas = postCanvas;
                }
            }
            exportCanvas.toBlob((blob) => {
                if (!blob) return;
                const reader = new FileReader();
                reader.onload = () => {
                    const base64 = btoa(String.fromCharCode(...new Uint8Array(reader.result)));
                    vscode.postMessage({ type: 'export_data', format: 'png', data: base64 });
                };
                reader.readAsArrayBuffer(blob);
            }, 'image/png');
        })();
    } else if (format === 'svg') {
        const svg = plotToSvg(currentPlot, exportW, exportH);
        const base64 = btoa(unescape(encodeURIComponent(svg)));
        vscode.postMessage({ type: 'export_data', format: 'svg', data: base64 });
    }
}

function svgEsc(s) { return s.replace(/&/g,'&amp;').replace(/[<]/g,'&lt;').replace(/[>]/g,'&gt;').replace(/"/g,'&quot;'); }

const cssFilterRe = /^(?:blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|opacity|saturate|sepia)\\s*\\([^()]*(?:\\([^)]*\\)[^()]*)*\\)(?:\\s+(?:blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|opacity|saturate|sepia)\\s*\\([^()]*(?:\\([^)]*\\)[^()]*)*\\))*$/;
function isSafeCssFilter(s) {
    if (typeof s !== 'string') return false;
    var trimmed = s.trim();
    return cssFilterRe.test(trimmed) && !/url\\s*\\(/i.test(trimmed);
}

function svgTag(name, attrs, selfClose) {
    return String.fromCharCode(60) + name + (attrs || '') + (selfClose ? '/>' : '>');
}
function svgClose(name) { return String.fromCharCode(60) + '/' + name + '>'; }

function svgGcStroke(gc) {
    if (!gc || gc.col == null) return ' stroke="none"';
    let s = ' stroke="' + gc.col + '"';
    s += ' stroke-width="' + (gc.lwd || 1) + '"';
    s += ' stroke-linecap="' + (gc.lend || 'round') + '"';
    s += ' stroke-linejoin="' + (gc.ljoin || 'round') + '"';
    if (gc.lty && gc.lty.length > 0) s += ' stroke-dasharray="' + gc.lty.join(',') + '"';
    return s;
}

function svgGcFill(gc) {
    if (!gc || gc.fill == null) return ' fill="none"';
    return ' fill="' + gc.fill + '"';
}

function svgFont(gc) {
    if (!gc || !gc.font) return { size: 12, family: 'sans-serif', style: '', weight: '' };
    const size = gc.font.size || 12;
    const family = mapFontFamily(gc.font.family);
    const face = gc.font.face || 1;
    return {
        size,
        family,
        weight: (face === 2 || face === 4) ? 'bold' : 'normal',
        style: (face === 3 || face === 4) ? 'italic' : 'normal'
    };
}

function plotToSvg(plot, exportW, exportH) {
    const w = plot.device.width;
    const h = plot.device.height;
    const outW = exportW || w;
    const outH = exportH || h;
    let s = svgTag('svg', ' xmlns="http://www.w3.org/2000/svg" width="' + outW + '" height="' + outH + '" viewBox="0 0 ' + w + ' ' + h + '"') + '\\n';

    if (plot.device.bg) {
        s += svgTag('rect', ' width="' + w + '" height="' + h + '" fill="' + plot.device.bg + '"', true) + '\\n';
    }

    let clipId = 0;
    const elementStack = [];

    for (const op of plot.ops) {
        switch (op.op) {
            case 'clip': {
                while (elementStack.length > 0) {
                    const top = elementStack[elementStack.length - 1];
                    if (top.kind === 'group') break;
                    elementStack.pop();
                    s += svgClose('g') + '\\n';
                    if (top.kind === 'clip') break;
                }
                clipId++;
                const cw = op.x1 - op.x0, ch = op.y1 - op.y0;
                const cx = Math.min(op.x0, op.x1), cy = Math.min(op.y0, op.y1);
                const aw = Math.abs(cw), ah = Math.abs(ch);
                s += svgTag('defs') + svgTag('clipPath', ' id="c' + clipId + '"') + svgTag('rect', ' x="' + cx + '" y="' + cy + '" width="' + aw + '" height="' + ah + '"', true) + svgClose('clipPath') + svgClose('defs') + '\\n';
                s += svgTag('g', ' clip-path="url(#c' + clipId + ')"') + '\\n';
                elementStack.push({kind: 'clip', attrs: ''});
                break;
            }
            case 'line':
                s += svgTag('line', ' x1="' + op.x1 + '" y1="' + op.y1 + '" x2="' + op.x2 + '" y2="' + op.y2 + '"' + svgGcStroke(op.gc) + ' fill="none"', true) + '\\n';
                break;
            case 'rect': {
                const rx = Math.min(op.x0, op.x1), ry = Math.min(op.y0, op.y1);
                const rw = Math.abs(op.x1 - op.x0), rh = Math.abs(op.y1 - op.y0);
                s += svgTag('rect', ' x="' + rx + '" y="' + ry + '" width="' + rw + '" height="' + rh + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\\n';
                break;
            }
            case 'circle':
                s += svgTag('circle', ' cx="' + op.x + '" cy="' + op.y + '" r="' + op.r + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\\n';
                break;
            case 'polyline': {
                if (op.x.length < 2) break;
                let pts = '';
                for (let i = 0; i < op.x.length; i++) pts += op.x[i] + ',' + op.y[i] + ' ';
                s += svgTag('polyline', ' points="' + pts.trim() + '"' + svgGcStroke(op.gc) + ' fill="none"', true) + '\\n';
                break;
            }
            case 'polygon': {
                let pts = '';
                for (let i = 0; i < op.x.length; i++) pts += op.x[i] + ',' + op.y[i] + ' ';
                s += svgTag('polygon', ' points="' + pts.trim() + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\\n';
                break;
            }
            case 'path': {
                let d = '';
                for (const sub of op.subpaths) {
                    if (sub.length === 0) continue;
                    d += 'M' + sub[0][0] + ' ' + sub[0][1];
                    for (let i = 1; i < sub.length; i++) d += 'L' + sub[i][0] + ' ' + sub[i][1];
                    d += 'Z';
                }
                const rule = op.winding === 'evenodd' ? 'evenodd' : 'nonzero';
                s += svgTag('path', ' d="' + d + '" fill-rule="' + rule + '"' + svgGcFill(op.gc) + svgGcStroke(op.gc), true) + '\\n';
                break;
            }
            case 'text': {
                const f = svgFont(op.gc);
                let anchor = 'start';
                if (op.hadj === 0.5) anchor = 'middle';
                else if (op.hadj === 1) anchor = 'end';
                const col = (op.gc && op.gc.col != null) ? op.gc.col : 'black';
                let transform = 'translate(' + op.x + ',' + op.y + ')';
                if (op.rot) transform += ' rotate(' + (-op.rot) + ')';
                s += svgTag('text', ' transform="' + transform + '" font-family="' + f.family + '" font-size="' + f.size + '" font-weight="' + f.weight + '" font-style="' + f.style + '" text-anchor="' + anchor + '" fill="' + col + '"') + svgEsc(op.str) + svgClose('text') + '\\n';
                break;
            }
            case 'raster': {
                const aw = Math.abs(op.w), ah = Math.abs(op.h);
                const dx = op.w >= 0 ? op.x : op.x + op.w;
                const dy = op.y - ah;
                let transform = '';
                if (op.rot) {
                    const cx = dx + aw / 2, cy = dy + ah / 2;
                    transform = ' transform="rotate(' + (-op.rot) + ',' + cx + ',' + cy + ')"';
                }
                s += svgTag('image', ' x="' + dx + '" y="' + dy + '" width="' + aw + '" height="' + ah + '" href="' + op.data + '"' + transform, true) + '\\n';
                break;
            }
            case 'beginGroup': {
                let gAttrs = '';
                if (op.ext) {
                    if (op.ext.opacity != null) {
                        const rawOpacity = Number(op.ext.opacity);
                        if (Number.isFinite(rawOpacity)) {
                            const clampedOpacity = Math.max(0, Math.min(1, rawOpacity));
                            gAttrs += ' opacity="' + clampedOpacity + '"';
                        }
                    }
                    if (op.ext.filter != null && isSafeCssFilter(op.ext.filter)) gAttrs += ' style="filter:' + svgEsc(op.ext.filter) + ';"';
                }
                s += svgTag('g', gAttrs) + '\\n';
                elementStack.push({kind: 'group', attrs: gAttrs});
                break;
            }
            case 'endGroup':
                while (elementStack.length > 0 && elementStack[elementStack.length - 1].kind === 'clip') {
                    elementStack.pop();
                    s += svgClose('g') + '\\n';
                }
                if (elementStack.length > 0 && elementStack[elementStack.length - 1].kind === 'group') {
                    elementStack.pop();
                    s += svgClose('g') + '\\n';
                }
                break;
        }
    }

    while (elementStack.length > 0) { elementStack.pop(); s += svgClose('g') + '\\n'; }
    s += svgClose('svg');
    return s;
}
`;
}
