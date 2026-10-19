import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { getDataViewerScript } from '../../dataViewer';

interface Viewer {
    applyJdvRowCount(session: string, value: typeof hint): void;
    bindRowCount(state: ReturnType<typeof panel>): void;
    panels: Map<string, ReturnType<typeof panel>>;
}

// Load the actual viewer module with its VS Code dependencies stubbed out.
function viewer(): Viewer {
    return vm.runInNewContext(fs.readFileSync(require.resolve('../../jdvViewer'), 'utf8') +
        '\n;({ applyJdvRowCount, bindRowCount, panels })', {
        exports: {}, require: (name: string) => name === './session' ? { getDocumentGeneration: () => 1 } : {},
    }) as Viewer;
}
const hint = { address: 'socket-a', view: 'v-1', generation: 1, nrow: 1000 };
function panel() {
    const messages: { knownTotal: number }[] = [];
    return { hintScope: JSON.stringify(['session-a', 'socket-a']), stream: {},
        descriptor: { view: 'v-1', generation: 1 }, knownTotal: undefined,
        panel: { webview: { postMessage: (message: { knownTotal: number }) => messages.push(message) } }, messages };
}

suite('jdv row-count hints', () => {
    test('takes a hint received before view/open', () => {
        const host = viewer(), state = panel();
        host.applyJdvRowCount('session-a', hint);
        host.bindRowCount(state);
        assert.equal(state.knownTotal, 1000);
    });

    test('updates an open panel when its hint arrives later', () => {
        const host = viewer(), state = panel();
        host.panels.set(JSON.stringify(['session-a', 'v-1']), state);
        host.applyJdvRowCount('session-a', hint);
        assert.equal(state.knownTotal, 1000);
        assert.equal(state.messages[0].knownTotal, 1000);
    });

    test('does not attach another scope or generation to the panel', () => {
        const host = viewer(), state = panel();
        host.panels.set(JSON.stringify(['session-a', 'v-1']), state);
        host.applyJdvRowCount('session-b', hint);
        host.applyJdvRowCount('session-a', { ...hint, address: 'socket-b' });
        host.applyJdvRowCount('session-a', { ...hint, generation: 2 });
        host.bindRowCount(state);
        assert.equal(state.knownTotal, undefined);
        assert.equal(state.messages.length, 0);
    });

    test('formats unknown, known and complete stream counts', () => {
        const format = vm.runInNewContext(getDataViewerScript() + ';formatSequentialRowCount') as
            (loaded: number, knownTotal: number | undefined, done: boolean) => string;
        assert.equal(format(2000, undefined, false), '2,000 / ??? rows');
        assert.equal(format(2000, 1000000, false), '2,000 / 1,000,000 rows');
        assert.equal(format(1000000, 1000000, true), '1,000,000 rows');
    });
});
