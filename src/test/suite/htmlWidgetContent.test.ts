import * as assert from 'assert';
import * as vm from 'vm';
import { initializeWidgetContent, initializeWidgetLoad, initializeWidgetState } from '../../webViewer/webview/widget';

suite('HTML output content controls', () => {
    function content(sessionOwned = true) {
        const posted: unknown[] = [];
        const events = new Map<string, (event: unknown) => void>();
        vm.runInNewContext(`(${initializeWidgetContent.toString()})(vscode, 7, sessionOwned)`, {
            document: { addEventListener: (name: string, listener: (event: unknown) => void) => events.set(name, listener) },
            window: {}, sessionOwned,
            vscode: { postMessage: (message: unknown) => posted.push(JSON.parse(JSON.stringify(message))) },
        });
        return { posted, events };
    }

    test('Alt arrows and mouse navigation send the owning document generation', () => {
        const widget = content();
        let prevented = 0;
        widget.events.get('keydown')!({ altKey: true, key: 'ArrowLeft', preventDefault: () => { prevented++; } });
        widget.events.get('mousedown')!({ button: 4, preventDefault: () => { prevented++; } });
        assert.strictEqual(prevented, 2);
        assert.deepStrictEqual(widget.posted, [
            { message: 'widget/navigate', direction: 'back', generation: 7 },
            { message: 'widget/navigate', direction: 'forward', generation: 7 },
        ]);
    });

    test('unowned outputs do not intercept history shortcuts or keys handled by a widget', () => {
        for (const owned of [false, true]) {
            const widget = content(owned);
            widget.events.get('keydown')!({ defaultPrevented: true, altKey: true, key: 'ArrowLeft' });
            if (!owned) {
                widget.events.get('keydown')!({ altKey: true, key: 'ArrowLeft' });
                widget.events.get('mousedown')!({ button: 3 });
            }
            assert.deepStrictEqual(widget.posted, []);
        }
    });

    test('Find works directly in the webview without a parent-frame bridge', () => {
        const widget = content();
        let prevented = false;
        widget.events.get('keydown')!({ ctrlKey: true, key: 'f', preventDefault: () => { prevented = true; } });
        assert.ok(prevented);
        assert.deepStrictEqual(widget.posted, [{ message: 'widget/find', generation: 7 }]);
    });

    test('reload state saves only the extension-owned panel reference', () => {
        let saved: unknown;
        initializeWidgetState({ setState: state => { saved = state; }, postMessage: () => {} }, { id: 'original-panel' });
        assert.deepStrictEqual(saved, { id: 'original-panel' });
    });

    test('readiness waits for document load and a paint, and reports its generation', () => {
        for (const readyState of ['loading', 'complete']) {
            const posted: unknown[] = [];
            const frames: Array<() => void> = [];
            let load: (() => void) | undefined;
            vm.runInNewContext(`(${initializeWidgetLoad.toString()})(vscode, 7)`, {
                document: { readyState },
                window: { addEventListener: (event: string, callback: () => void, options: { once: boolean }) => {
                    assert.strictEqual(event, 'load'); assert.strictEqual(options.once, true); load = callback;
                } },
                requestAnimationFrame: (callback: () => void) => frames.push(callback),
                vscode: { postMessage: (message: unknown) => posted.push(JSON.parse(JSON.stringify(message))) },
            });
            if (readyState === 'loading') {
                assert.strictEqual(frames.length, 0, 'Do not acknowledge before resources load');
                load!();
            }
            assert.deepStrictEqual(posted, []);
            frames.shift()!();
            assert.deepStrictEqual(posted, [], 'Wait until the browser has had a paint opportunity');
            frames.shift()!();
            assert.deepStrictEqual(posted, [{ message: 'widget/loaded', generation: 7 }]);
        }
    });
});
