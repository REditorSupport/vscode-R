import * as assert from 'assert';
import * as vm from 'vm';
import { getViewerSessionScript } from '../../viewerSession';

suite('Viewer session tooltip updates', () => {
    test('refreshes details and the accessible label without rebuilding the viewer', () => {
        let receive: (event: { data: unknown }) => void = () => undefined;
        let ready: () => void = () => undefined;
        let label = 'R 4.6.1: 12101';
        const tooltip = { textContent: label };
        const posted: unknown[] = [];
        vm.runInNewContext(getViewerSessionScript(), {
            window: { addEventListener: (_type: string, listener: typeof receive) => { receive = listener; } },
            document: {
                readyState: 'loading',
                addEventListener: (type: string, listener: typeof ready) => {
                    if (type === 'DOMContentLoaded') { ready = listener; }
                },
                querySelector: () => ({ addEventListener: () => undefined, setAttribute: (name: string, text: string) => {
                    assert.strictEqual(name, 'aria-label'); label = text;
                } }),
                getElementById: () => tooltip,
            },
            vscode: { postMessage: (message: unknown) => posted.push(message) },
        });
        assert.strictEqual(posted.length, 0);
        ready();
        assert.deepStrictEqual(JSON.parse(JSON.stringify(posted)), [{ message: 'viewer-session/ready' }]);
        receive({ data: null });
        receive({ data: { message: 'dataview/response', text: 'unrelated' } });
        assert.strictEqual(tooltip.textContent, 'R 4.6.1: 12101');
        receive({ data: { message: 'viewer-session/update', text: 'R: (not attached)' } });
        assert.strictEqual(tooltip.textContent, 'R: (not attached)');
        assert.strictEqual(label, 'R: (not attached)');
        receive({ data: { message: 'viewer-session/update', text: 42 } });
        assert.strictEqual(tooltip.textContent, 'R: (not attached)');
    });

    test('Escape dismisses the tooltip without moving focus and it reopens on a new focus or hover', () => {
        const attributes = new Map<string, string>();
        const iconEvents = new Map<string, () => void>();
        let focused = true;
        let hovered = false;
        let consumed = 0;
        let keydown: (event: { key: string; preventDefault(): void; stopPropagation(): void }) => void = () => undefined;
        const icon = {
            addEventListener: (type: string, listener: () => void) => iconEvents.set(type, listener),
            setAttribute: (name: string, value: string) => attributes.set(name, value),
            removeAttribute: (name: string) => attributes.delete(name),
            hasAttribute: (name: string) => attributes.has(name),
            matches: () => focused || hovered,
            blur: () => assert.fail('Escape must preserve keyboard focus'),
        };
        vm.runInNewContext(getViewerSessionScript(), {
            window: { addEventListener: () => undefined },
            document: {
                readyState: 'complete', querySelector: () => icon,
                addEventListener: (_type: string, listener: typeof keydown) => { keydown = listener; },
            },
            vscode: { postMessage: () => undefined },
        });
        const key = (value: string) => keydown({
            key: value, preventDefault: () => { consumed++; }, stopPropagation: () => undefined,
        });
        key('Enter');
        assert.ok(!attributes.has('data-tooltip-dismissed'));
        key('Escape');
        assert.ok(attributes.has('data-tooltip-dismissed'));
        assert.strictEqual(focused, true);
        assert.strictEqual(consumed, 1);
        key('Escape');
        assert.strictEqual(consumed, 1, 'Dismissed tooltips should not consume further Escape presses');
        iconEvents.get('focus')!();
        assert.ok(!attributes.has('data-tooltip-dismissed'));
        key('Escape');
        assert.ok(attributes.has('data-tooltip-dismissed'));
        focused = false;
        hovered = true;
        iconEvents.get('pointerenter')!();
        assert.ok(!attributes.has('data-tooltip-dismissed'));
        key('Escape');
        assert.ok(attributes.has('data-tooltip-dismissed'));
        hovered = false;
        key('Escape');
        assert.strictEqual(consumed, 3);
    });
});
