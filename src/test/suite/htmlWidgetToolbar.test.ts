import * as assert from 'assert';
import * as vm from 'vm';
import { initializeWidgetToolbar } from '../../webViewer/webview/toolbar';

suite('HTML widget toolbar controls', () => {
    function toolbar(backDisabled = false, forwardDisabled = false, removeDisabled = false) {
        const back = { disabled: backDisabled, onclick: undefined as (() => void) | undefined };
        const forward = { disabled: forwardDisabled, onclick: undefined as (() => void) | undefined };
        const remove = { disabled: removeDisabled, onclick: undefined as (() => void) | undefined };
        const frame = { contentWindow: {}, dataset: {} };
        const posted: unknown[] = [];
        const events = new Map<string, (event: unknown) => void>();
        const elements = new Map<string, unknown>([
            ['widget-toolbar', { dataset: { generation: '7' } }],
            ['widget-back', back], ['widget-forward', forward], ['widget-frame', frame],
            ['widget-remove', remove],
        ]);
        vm.runInNewContext(`(${initializeWidgetToolbar.toString()})(vscode)`, {
            document: {
                getElementById: (id: string) => elements.get(id),
                addEventListener: (name: string, listener: (event: unknown) => void) => events.set(name, listener),
            },
            window: { addEventListener: (name: string, listener: (event: unknown) => void) => events.set(name, listener) },
            vscode: { postMessage: (message: unknown) => posted.push(JSON.parse(JSON.stringify(message))) },
        });
        return { back, forward, remove, frame, posted, events };
    }

    test('disabled boundaries do nothing and enabled clicks send the displayed generation once', () => {
        const first = toolbar(true, false);
        first.back.onclick!();
        assert.strictEqual(first.posted.length, 0);
        first.forward.onclick!();
        assert.deepStrictEqual(first.posted, [{ message: 'widget/navigate', direction: 'forward', generation: 7 }]);
        assert.ok(first.back.disabled && first.forward.disabled && first.remove.disabled);
        first.remove.onclick!();
        first.forward.onclick!();
        assert.strictEqual(first.posted.length, 1);
    });

    test('remove sends the displayed generation once and locks navigation until rendering finishes', () => {
        const empty = toolbar(true, true, true);
        empty.remove.onclick!();
        assert.strictEqual(empty.posted.length, 0);
        const widget = toolbar();
        widget.remove.onclick!();
        assert.deepStrictEqual(widget.posted, [{ message: 'widget/remove', generation: 7 }]);
        assert.ok(widget.back.disabled && widget.forward.disabled && widget.remove.disabled);
        widget.remove.onclick!(); widget.back.onclick!(); widget.forward.onclick!();
        assert.strictEqual(widget.posted.length, 1);
    });

    test('keyboard and mouse shortcuts navigate in the host and inside the widget', () => {
        const keyboard = toolbar();
        let prevented = false;
        keyboard.events.get('keydown')!({ altKey: true, key: 'ArrowLeft', preventDefault: () => { prevented = true; } });
        assert.ok(prevented);
        assert.deepStrictEqual(keyboard.posted, [{ message: 'widget/navigate', direction: 'back', generation: 7 }]);
        const mouse = toolbar();
        mouse.events.get('mousedown')!({ button: 4, preventDefault: () => undefined });
        assert.deepStrictEqual(mouse.posted, [{ message: 'widget/navigate', direction: 'forward', generation: 7 }]);
        const widget = toolbar();
        const receive = widget.events.get('message')!;
        receive({ source: {}, data: { message: 'widget/bridge', direction: 'back' } });
        assert.strictEqual(widget.posted.length, 0);
        receive({ source: widget.frame.contentWindow, data: { message: 'widget/bridge', direction: 'back' } });
        assert.deepStrictEqual(widget.posted, [{ message: 'widget/navigate', direction: 'back', generation: 7 }]);
    });

    test('only the widget frame can forward supported external links', () => {
        const widget = toolbar();
        const receive = widget.events.get('message')!;
        receive({ source: {}, data: { message: 'widget/bridge', href: 'https://example.com' } });
        receive({ source: widget.frame.contentWindow, data: { message: 'widget/bridge', href: 'javascript:alert(1)' } });
        assert.strictEqual(widget.posted.length, 0);
        receive({ source: widget.frame.contentWindow, data: { message: 'widget/bridge', href: 'https://example.com' } });
        assert.deepStrictEqual(widget.posted, [{ message: 'linkClicked', href: 'https://example.com', scrollY: 0 }]);
    });

    test('only the widget frame can request Find for the displayed generation', () => {
        const widget = toolbar();
        const receive = widget.events.get('message')!;
        receive({ source: {}, data: { message: 'widget/bridge', command: 'find' } });
        receive({ source: widget.frame.contentWindow, data: { message: 'widget/bridge', command: 'unknown' } });
        assert.strictEqual(widget.posted.length, 0);
        receive({ source: widget.frame.contentWindow, data: { message: 'widget/bridge', command: 'find' } });
        assert.deepStrictEqual(widget.posted, [{ message: 'widget/find', generation: 7 }]);
        assert.ok(!widget.back.disabled && !widget.forward.disabled && !widget.remove.disabled);
    });
});
