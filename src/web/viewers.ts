import * as vscode from 'vscode';
import { DISPLAY_MIME } from '../interactive/notebook';
import { queryTablePage } from '../interactive/tableQuery';

type Data = Record<string, unknown>;
type Inspect = (method: string, params: Data) => Promise<unknown>;

function object(value: unknown): Data {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid R viewer response.');
    }
    return value as Data;
}
function entryPath(value: unknown): number[] {
    const path = value ?? [];
    if (!Array.isArray(path) || !path.every((index) => Number.isSafeInteger(index) && index > 0)) {
        throw new Error('Invalid R list path.');
    }
    return path as number[];
}

/** A saved cell carries its preview. Only its owning worker can service live requests. */
export class BrowserViewers implements vscode.Disposable {
    private readonly generation = crypto.randomUUID();
    private readonly panels = new Set<vscode.WebviewPanel>();
    private closed = false;

    constructor(
        private readonly extension: vscode.Uri,
        private readonly doc: vscode.NotebookDocument,
        private readonly inspect: Inspect,
    ) {}

    public output(source: Data): vscode.NotebookCellOutput {
        const displayId = crypto.randomUUID();
        const data = {
            ...source,
            displayId,
            generation: this.generation,
            connected: true,
            ...(source.kind === 'htmlText' ? { inlineOnly: true } : {}),
        };
        const fallback =
            typeof source.printedText === 'string'
                ? source.printedText
                : source.kind === 'htmlText'
                  ? 'R HTML widget'
                  : source.kind === 'list'
                    ? 'R list'
                    : 'R table';
        return new vscode.NotebookCellOutput(
            [
                vscode.NotebookCellOutputItem.json(data, DISPLAY_MIME),
                vscode.NotebookCellOutputItem.text(fallback),
            ],
            { rDisplayId: displayId },
        );
    }

    async rendererMessage(message: Data): Promise<unknown> {
        if (this.closed || message.generation !== this.generation) {
            throw new Error(
                'This output belongs to a previous webR session. Run its cell again to use live controls.',
            );
        }
        // Only dispatch addresses present in an output from this session. R handles
        // are capability-like identifiers and must never come from renderer input.
        const output = this.doc
            .getCells()
            .flatMap((cell) => cell.outputs)
            .find((out) => out.metadata?.rDisplayId === message.displayId);
        const item = output?.items.find((value) => value.mime === DISPLAY_MIME);
        if (!item) {
            throw new Error('This webR output is no longer available.');
        }
        const data = object(JSON.parse(new TextDecoder().decode(item.data)));
        if (data.generation !== this.generation || data.displayId !== message.displayId) {
            throw new Error('This webR output is no longer connected.');
        }
        if (message.action === 'table' && data.kind === 'table') {
            await this.openValue('table', String(data.fullViewId ?? data.viewId), 'R Data Viewer');
        } else if (message.action === 'list' && data.kind === 'list') {
            await this.openValue(
                'list',
                String(data.viewId),
                'R List Viewer',
                entryPath(message.path),
            );
        } else {
            return this.query(data, message);
        }
    }

    async openValue(kind: string, id: string, title: string, path: number[] = []): Promise<void> {
        if (kind === 'list') {
            const params = { view_id: id, path };
            const navigation = object(await this.inspect('listview_navigate', params));
            const page = object(await this.inspect('workspace_children', { ...params, start: 1 }));
            this.panel(title, { ...page, kind, viewId: id, navigation });
        } else if (kind === 'table') {
            const meta = object(await this.inspect('dataview_init', { view_id: id }));
            const page = object(
                await this.inspect('dataview_page', {
                    view_id: id,
                    startRow: 0,
                    endRow: 20,
                    formatNumbers: true,
                }),
            );
            this.panel(title, { ...meta, ...page, kind, viewId: id });
        }
    }

    private async query(data: Data, message: Data): Promise<unknown> {
        if (message.action === 'page' && data.kind === 'table') {
            return queryTablePage(data, message, async (req) =>
                object(await this.inspect(req.method, req.params)),
            );
        }
        if (data.kind !== 'list') {
            return;
        }
        const params = { view_id: data.viewId, path: entryPath(message.path) };
        if (message.action === 'listPage') {
            const start = message.start;
            if (!Number.isSafeInteger(start) || Number(start) < 1) {
                throw new Error('Invalid R list page.');
            }
            return this.inspect('workspace_children', { ...params, start });
        }
        if (message.action === 'listNavigate' || message.action === 'listItem') {
            const item = message.action === 'listItem';
            if (item && (!Number.isSafeInteger(message.index) || Number(message.index) < 1)) {
                throw new Error('Invalid R list index.');
            }
            const result = await this.inspect(
                item ? 'listview_view' : 'listview_navigate',
                item ? { ...params, index: message.index } : params,
            );
            if (!result) {
                throw new Error('This list item is no longer available.');
            }
            return typeof result === 'object' ? { navigation: result } : undefined;
        }
    }

    private panel(title: string, data: Data): void {
        if (this.closed) {
            return;
        }
        const dist = vscode.Uri.joinPath(this.extension, 'dist');
        const panel = vscode.window.createWebviewPanel(
            'r.webR.viewer',
            title,
            {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: true,
            },
            {
                enableScripts: true,
                localResourceRoots: [dist],
                retainContextWhenHidden: true,
            },
        );
        this.panels.add(panel);
        const webview = panel.webview;
        const displayId = crypto.randomUUID();
        const panelSecret = crypto.randomUUID();
        const dispose = webview.onDidReceiveMessage(async (message: Data) => {
            if (this.closed) {
                return;
            }
            if (
                !message ||
                message.panelSecret !== panelSecret ||
                message.displayId !== displayId ||
                message.generation !== this.generation
            ) {
                return;
            }
            try {
                const result = await this.query(data, message);
                await webview.postMessage({
                    panelSecret,
                    outputId: message.outputId,
                    requestId: message.requestId,
                    action: message.action,
                    result,
                });
            } catch (error) {
                await webview.postMessage({
                    panelSecret,
                    outputId: message.outputId,
                    requestId: message.requestId,
                    action: message.action,
                    error: String(error),
                });
            }
        });
        panel.onDidDispose(() => {
            this.panels.delete(panel);
            dispose.dispose();
        });
        const renderer = webview
            .asWebviewUri(vscode.Uri.joinPath(dist, 'interactive-renderer.js'))
            .toString();
        const nonce = crypto.randomUUID();
        webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource} 'nonce-${nonce}' ${new URL(renderer).origin}; style-src 'unsafe-inline'"></head><body><main></main><script type="module" nonce="${nonce}">
import { activate } from "${renderer}";
const api = acquireVsCodeApi();
const listeners = new Set();
const secret = ${JSON.stringify(panelSecret)};
const renderer = activate({ postMessage: m => api.postMessage({...m,panelSecret:secret}), onDidReceiveMessage: fn => { listeners.add(fn); return {dispose:() => listeners.delete(fn)}; } });
window.addEventListener('message', event => {
    // The webview host dispatches messages from a host-specific source.
    // Authenticate responses with a capability private to this particular panel.
    if (event.data?.panelSecret !== secret || event.data?.outputId !== 'panel') return;
    const msg = event.data;
    for (const fn of listeners) fn(msg);
});
const initial = ${JSON.stringify({ ...data, displayId, generation: this.generation, panel: true }).replace(/</g, '\\u003c')};
renderer.renderOutputItem({id:'panel',json:()=>initial},document.querySelector('main'));
</script></body></html>`;
    }

    dispose(): void {
        this.closed = true;
        for (const panel of this.panels) {
            panel.dispose();
        }
        this.panels.clear();
    }
}
