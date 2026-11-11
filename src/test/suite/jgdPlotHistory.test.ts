import * as assert from 'assert';
import { PlotHistory, PlotFrame } from '../../plotViewer/jgdPlotHistory';

function makePlot(label: string, width = 400, height = 300): PlotFrame {
    return {
        version: 1,
        sessionId: '',
        device: { width, height, dpi: 96, bg: label },
        ops: [{ op: 'rect', label }],
    };
}

suite('JGD PlotHistory', () => {
    let history: PlotHistory;

    setup(() => {
        history = new PlotHistory(50);
    });

    suite('addPlot', () => {
        test('adds a plot and sets it as current', () => {
            history.addPlot('s1', makePlot('A'));
            assert.strictEqual(history.count(), 1);
            assert.strictEqual(history.currentIndex(), 1);
            assert.strictEqual(history.currentPlot()?.device.bg, 'A');
        });

        test('appends multiple plots', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            assert.strictEqual(history.count(), 2);
            assert.strictEqual(history.currentIndex(), 2);
            assert.strictEqual(history.currentPlot()?.device.bg, 'B');
        });
    });

    suite('navigation', () => {
        setup(() => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.addPlot('s1', makePlot('C'));
        });

        test('navigatePrevious moves backward', () => {
            const plot = history.navigatePrevious();
            assert.strictEqual(plot?.device.bg, 'B');
            assert.strictEqual(history.currentIndex(), 2);
        });

        test('navigateNext moves forward', () => {
            history.navigatePrevious();
            const plot = history.navigateNext();
            assert.strictEqual(plot?.device.bg, 'C');
            assert.strictEqual(history.currentIndex(), 3);
        });

        test('navigatePrevious returns null at beginning', () => {
            history.navigatePrevious();
            history.navigatePrevious();
            assert.strictEqual(history.navigatePrevious(), null);
            assert.strictEqual(history.currentIndex(), 1);
        });

        test('navigateNext returns null at end', () => {
            assert.strictEqual(history.navigateNext(), null);
            assert.strictEqual(history.currentIndex(), 3);
        });

        test('first and last navigation emit one change without visiting intermediate plots', () => {
            let changes = 0;
            history.onDidChange(() => changes++);
            assert.strictEqual(history.navigateFirst()?.device.bg, 'A');
            assert.strictEqual(changes, 1);
            assert.strictEqual(history.navigateFirst(), null);
            assert.strictEqual(changes, 1);
            assert.strictEqual(history.navigateLast()?.device.bg, 'C');
            assert.strictEqual(changes, 2);
            assert.strictEqual(history.navigateLast(), null);
            assert.strictEqual(changes, 2);
        });
    });

    suite('removeCurrent', () => {
        test('removes the only plot', () => {
            history.addPlot('s1', makePlot('A'));
            const remaining = history.removeCurrent();
            assert.strictEqual(remaining, null);
            assert.strictEqual(history.count(), 0);
        });

        test('removes middle plot and stays in bounds', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.addPlot('s1', makePlot('C'));
            history.navigatePrevious();
            const remaining = history.removeCurrent();
            assert.strictEqual(remaining?.device.bg, 'C');
            assert.strictEqual(history.count(), 2);
        });

        test('removes last plot and adjusts index', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            const remaining = history.removeCurrent();
            assert.strictEqual(remaining?.device.bg, 'A');
            assert.strictEqual(history.count(), 1);
            assert.strictEqual(history.currentIndex(), 1);
        });

        test('returns null on empty history', () => {
            assert.strictEqual(history.removeCurrent(), null);
        });
    });

    suite('clear', () => {
        test('removes all plots', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.clear();
            assert.strictEqual(history.count(), 0);
            assert.strictEqual(history.currentPlot(), null);
        });
    });

    suite('replaceCurrent', () => {
        test('replaces the current plot in place', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.replaceCurrent('s1', makePlot('B2'));
            assert.strictEqual(history.count(), 2);
            assert.strictEqual(history.currentPlot()?.device.bg, 'B2');
        });

        test('falls back to addPlot on empty session', () => {
            history.replaceCurrent('s1', makePlot('A'));
            assert.strictEqual(history.count(), 1);
            assert.strictEqual(history.currentPlot()?.device.bg, 'A');
        });

        test('replaces at navigated position, not latest', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.navigatePrevious();
            history.replaceCurrent('s1', makePlot('A2'));
            assert.strictEqual(history.currentPlot()?.device.bg, 'A2');
            history.navigateNext();
            assert.strictEqual(history.currentPlot()?.device.bg, 'B');
        });
    });

    suite('replaceLatest', () => {
        test('replaces the latest plot regardless of navigation', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.navigatePrevious();
            const accepted = history.replaceLatest('s1', makePlot('B2'));
            assert.strictEqual(accepted, true);
            assert.strictEqual(history.currentPlot()?.device.bg, 'A');
            history.navigateNext();
            assert.strictEqual(history.currentPlot()?.device.bg, 'B2');
        });

        test('falls back to addPlot on empty session', () => {
            const accepted = history.replaceLatest('s1', makePlot('A'));
            assert.strictEqual(accepted, true);
            assert.strictEqual(history.count(), 1);
        });
    });

    suite('latestDeleted', () => {
        test('replaceLatest is rejected after deleting latest plot', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.removeCurrent();
            assert.strictEqual(history.count(), 1);
            assert.strictEqual(history.currentPlot()?.device.bg, 'A');

            const accepted = history.replaceLatest('s1', makePlot('stale'));
            assert.strictEqual(accepted, false);
            assert.strictEqual(history.count(), 1);
            assert.strictEqual(history.currentPlot()?.device.bg, 'A');
        });

        test('deleting non-latest plot does not arm latestDeleted', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.navigatePrevious();
            history.removeCurrent();
            assert.strictEqual(history.count(), 1);

            const accepted = history.replaceLatest('s1', makePlot('B2'));
            assert.strictEqual(accepted, true);
            assert.strictEqual(history.currentPlot()?.device.bg, 'B2');
        });

        test('addPlot resets latestDeleted', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.removeCurrent();

            history.addPlot('s1', makePlot('C'));
            const accepted = history.replaceLatest('s1', makePlot('C2'));
            assert.strictEqual(accepted, true);
            assert.strictEqual(history.currentPlot()?.device.bg, 'C2');
        });

        test('clear resets latestDeleted', () => {
            history.addPlot('s1', makePlot('A'));
            history.removeCurrent();
            history.clear();

            history.addPlot('s1', makePlot('B'));
            const accepted = history.replaceLatest('s1', makePlot('B2'));
            assert.strictEqual(accepted, true);
        });

        test('replaceLatest is rejected on empty session after deleting last plot', () => {
            history.addPlot('s1', makePlot('A'));
            history.removeCurrent();
            assert.strictEqual(history.count(), 0);

            const accepted = history.replaceLatest('s1', makePlot('stale'));
            assert.strictEqual(accepted, false);
            assert.strictEqual(history.count(), 0);
        });
    });

    suite('resize after delete (jgd#11)', () => {
        test('must not replace remaining plot with stale resize frame', () => {
            history.addPlot('s1', makePlot('RED'));
            history.addPlot('s1', makePlot('BLUE'));

            history.removeCurrent();
            assert.strictEqual(history.count(), 1);
            assert.strictEqual(history.currentPlot()?.device.bg, 'RED');

            const accepted = history.replaceLatest('s1', makePlot('BLUE', 800, 600));
            assert.strictEqual(accepted, false);

            assert.strictEqual(history.count(), 1);
            assert.strictEqual(history.currentPlot()?.device.bg, 'RED');
        });

        test('resize works normally when latest was not deleted', () => {
            history.addPlot('s1', makePlot('RED'));
            history.addPlot('s1', makePlot('BLUE'));

            const accepted = history.replaceLatest('s1', makePlot('BLUE', 800, 600));
            assert.strictEqual(accepted, true);
            assert.strictEqual(history.count(), 2);
            assert.strictEqual(history.currentPlot()?.device.bg, 'BLUE');
            assert.strictEqual(history.currentPlot()?.device.width, 800);
        });
    });

    suite('appendOps', () => {
        test('appends ops to the latest plot', () => {
            history.addPlot('s1', makePlot('A'));
            const extra: PlotFrame = {
                version: 1,
                sessionId: '',
                ops: [{ op: 'line', label: 'extra' }],
                device: { width: 400, height: 300, dpi: 96, bg: 'A' },
            };
            history.appendOps('s1', extra);
            assert.strictEqual(history.count(), 1);
            const ops = history.currentPlot()!.ops as { op: string }[];
            assert.strictEqual(ops.length, 2);
            assert.strictEqual(ops[0].op, 'rect');
            assert.strictEqual(ops[1].op, 'line');
        });

        test('always targets latest plot, not navigated position', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.navigatePrevious();
            const extra: PlotFrame = {
                version: 1,
                sessionId: '',
                ops: [{ op: 'line' }],
                device: { width: 400, height: 300, dpi: 96, bg: 'B' },
            };
            history.appendOps('s1', extra);
            assert.strictEqual(history.currentPlot()!.ops.length, 1);
            history.navigateNext();
            assert.strictEqual(history.currentPlot()!.ops.length, 2);
        });

        test('is rejected when latestDeleted is true', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.removeCurrent();
            const extra: PlotFrame = {
                version: 1,
                sessionId: '',
                ops: [{ op: 'line' }],
                device: { width: 400, height: 300, dpi: 96, bg: 'A' },
            };
            history.appendOps('s1', extra);
            assert.strictEqual(history.count(), 1);
            assert.strictEqual(history.currentPlot()!.ops.length, 1);
        });
    });

    suite('replaceLatest expectedRIndex guard', () => {
        test('accepts replacement when expectedRIndex matches', () => {
            const plot1 = makePlot('A');
            plot1.rIndex = 0;
            history.addPlot('s1', plot1);
            const accepted = history.replaceLatest('s1', makePlot('A-resized', 800, 600), 0);
            assert.strictEqual(accepted, true);
            assert.strictEqual(history.currentPlot()?.device.width, 800);
        });

        test('rejects replacement when expectedRIndex does not match', () => {
            const plot1 = makePlot('A');
            plot1.rIndex = 0;
            history.addPlot('s1', plot1);
            const plot2 = makePlot('B');
            plot2.rIndex = 1;
            history.addPlot('s1', plot2);
            const accepted = history.replaceLatest('s1', makePlot('A-resized', 800, 600), 0);
            assert.strictEqual(accepted, false);
            assert.strictEqual(history.currentPlot()?.device.bg, 'B');
        });
    });

    suite('eviction', () => {
        test('evicts oldest plots when maxPlots exceeded', () => {
            const small = new PlotHistory(3);
            small.addPlot('s1', makePlot('A'));
            small.addPlot('s1', makePlot('B'));
            small.addPlot('s1', makePlot('C'));
            small.addPlot('s1', makePlot('D'));
            assert.strictEqual(small.count(), 3);
            small.navigatePrevious();
            small.navigatePrevious();
            assert.strictEqual(small.currentPlot()?.device.bg, 'B');
        });
    });

    suite('multi-session', () => {
        test('navigates and removes plots in one session without changing another', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            history.addPlot('s2', makePlot('C'));
            history.addPlot('s2', makePlot('D'));
            assert.deepStrictEqual(history.sessionIds(), ['s1', 's2']);
            assert.strictEqual(history.navigatePrevious('s1')?.device.bg, 'A');
            assert.strictEqual(history.currentPlot('s2')?.device.bg, 'D');
            history.removeCurrent('s1');
            assert.strictEqual(history.currentPlot('s1')?.device.bg, 'B');
            assert.strictEqual(history.currentIndex('s2'), 2);
            history.clear('s1');
            assert.strictEqual(history.count('s1'), 0);
            assert.strictEqual(history.count('s2'), 2);
        });

        test('a late resize reply changes only its own session', () => {
            history.addPlot('s1', { ...makePlot('A'), rIndex: 0 });
            history.addPlot('s2', makePlot('B'));
            history.replaceAtIndex('s1', 0, makePlot('A resized'));
            assert.strictEqual(history.getActiveSessionId(), 's2');
            assert.strictEqual(history.currentPlot('s1')?.device.bg, 'A resized');
            assert.strictEqual(history.currentPlot('s2')?.device.bg, 'B');
        });

        test('tracks plots independently per session', () => {
            history.addPlot('s1', makePlot('S1-A'));
            history.addPlot('s2', makePlot('S2-A'));
            assert.strictEqual(history.currentPlot()?.device.bg, 'S2-A');
            assert.strictEqual(history.count(), 1);

            history.addPlot('s1', makePlot('S1-B'));
            assert.strictEqual(history.currentPlot()?.device.bg, 'S1-B');
            assert.strictEqual(history.count(), 2);
        });
    });

    suite('session timelines', () => {
        const owner = {
            sessionId: 'r',
            host: 'localhost',
            pid: '123',
            rVer: '4.5.0',
            processExited: false,
        };
        function add(device: string, label: string, rIndex = 0) {
            history.addPlot(device, { ...makePlot(label), rIndex });
            history.setSessionSource(device, owner);
        }

        test('interleaves devices and navigates one shared cursor with device-local replay indices', () => {
            add('a', 'A0');
            add('b', 'B0');
            add('a', 'A1', 1);
            assert.strictEqual(history.count('a'), 3);
            assert.strictEqual(history.count('b'), 3);
            assert.strictEqual(history.navigatePrevious('b')?.device.bg, 'B0');
            assert.strictEqual(history.currentPlot('a')?.sessionId, 'b');
            history.replaceAtIndex('a', 0, makePlot('A resized'));
            assert.strictEqual(history.currentPlot('b')?.device.bg, 'B0');
            assert.strictEqual(history.navigatePrevious('a')?.device.bg, 'A resized');
            assert.strictEqual(history.currentPlot('a')?.sessionId, 'a');
            assert.strictEqual(history.navigateLast('b')?.device.bg, 'A1');
        });

        test('incremental frames and late resize replies retain the selected plot', () => {
            add('a', 'A0');
            add('b', 'B0');
            history.appendOps('a', { ...makePlot('A0'), ops: [{ op: 'line' }] });
            history.replaceLatest('a', makePlot('A resized'), 0);
            assert.strictEqual(history.currentPlot('a')?.device.bg, 'B0');
            assert.strictEqual(history.latestPlot('a')?.device.bg, 'A resized');
            assert.strictEqual(history.count('b'), 2);
        });

        test('deleting the latest frame of an older device rejects its stale replies', () => {
            add('a', 'A0');
            add('b', 'B0');
            history.navigateFirst('b');
            history.removeCurrent('b');
            assert.strictEqual(history.isLatestDeleted('a'), true);
            assert.strictEqual(history.replaceLatest('a', makePlot('stale')), false);
            assert.strictEqual(history.appendOps('a', makePlot('stale')), false);
            assert.strictEqual(history.currentPlot('a')?.device.bg, 'B0');
            add('a', 'A1', 1);
            assert.strictEqual(history.count('b'), 2);
        });

        test('clear removes the entire session and rejects in-flight device frames', () => {
            add('a', 'A0');
            add('b', 'B0');
            history.addPlot('other-session', makePlot('other'));
            history.clear('a');
            assert.strictEqual(history.count('b'), 0);
            assert.strictEqual(history.replaceLatest('a', makePlot('stale')), false);
            assert.strictEqual(history.replaceLatest('b', makePlot('stale')), false);
            assert.strictEqual(history.count('other-session'), 1);
        });

        test('applies the history limit across devices without resurrecting evicted plots', () => {
            history = new PlotHistory(2);
            add('a', 'A0');
            add('b', 'B0');
            add('b', 'B1', 1);
            assert.strictEqual(history.count('a'), 2);
            assert.strictEqual(history.latestPlot('a'), undefined);
            assert.strictEqual(history.replaceLatest('a', makePlot('stale')), false);
            assert.strictEqual(history.navigateFirst('a')?.device.bg, 'B0');
        });

        test('late owner binding preserves arrival order', () => {
            history.addPlot('a', makePlot('A0'));
            history.addPlot('b', makePlot('B0'));
            history.addPlot('a', makePlot('A1'));
            history.setSessionSource('b', owner);
            history.setSessionSource('a', owner);
            assert.strictEqual(history.navigateFirst('a')?.device.bg, 'A0');
            assert.strictEqual(history.navigateNext('a')?.device.bg, 'B0');
            assert.strictEqual(history.navigateNext('b')?.device.bg, 'A1');
        });

        test('reload preserves interleaving and cursor, including a reduced history limit', () => {
            add('a', 'A0');
            add('b', 'B0');
            add('a', 'A1', 1);
            add('b', 'B1', 1);
            history.navigatePrevious('a');
            const saved = JSON.parse(JSON.stringify(history.snapshot())) as unknown;
            for (const limit of [50, 2]) {
                const restored = new PlotHistory(limit);
                restored.restore(saved);
                assert.strictEqual(restored.count('a'), Math.min(limit, 4));
                assert.strictEqual(restored.currentPlot('b')?.device.bg, 'A1');
                assert.strictEqual(restored.navigateNext('a')?.device.bg, 'B1');
            }
        });

        test('reconnect identity transfer preserves history and rejects another owner', () => {
            add('explicit', 'A0');
            add('other', 'B0');
            history.navigateFirst('other');
            history.restoreDeviceIdentity('explicit', 'wrong', { ...owner, pid: '456' });
            assert.strictEqual(history.sessionSource('wrong'), undefined);
            history.restoreDeviceIdentity('explicit', 'logical', owner);
            history.invalidateReplayIndices('logical');
            history.replaceLatest('logical', { ...makePlot('restored'), rIndex: 0 });
            assert.strictEqual(history.count('explicit'), 0);
            assert.strictEqual(history.count('logical'), 2);
            assert.strictEqual(history.currentPlot('other')?.sessionId, 'logical');
            assert.strictEqual(history.currentPlot('other')?.device.bg, 'restored');
            assert.strictEqual(history.latestPlot('other')?.device.bg, 'B0');
        });

        test('legacy snapshots merge devices only when their full owner identities match', () => {
            add('a', 'A0');
            add('b', 'B0');
            history.addPlot('c', makePlot('C0'));
            history.setSessionSource('c', { ...owner, host: 'another-host' });
            const saved = history.snapshot();
            delete saved.timelines;
            const restored = new PlotHistory();
            restored.restore(saved);
            assert.strictEqual(restored.count('a'), 2);
            assert.strictEqual(restored.count('c'), 1);
        });
    });

    test('checkpoints reuse unchanged frames and isolate every kind of live frame mutation', () => {
        const owner = {
            sessionId: 'owner',
            host: 'host',
            pid: '123',
            rVer: '4.6.0',
            processExited: false,
        };
        history.addPlot('a', { ...makePlot('A'), rIndex: 0 });
        history.setSessionSource('a', owner);
        history.addPlot('b', makePlot('B'));
        const first = history.snapshot();
        const original = structuredClone(first);
        history.appendOps('a', { ...makePlot('A'), ops: [{ op: 'text', str: 'extra' }] });
        const appended = history.snapshot();
        assert.strictEqual(appended.sessions[1].plots[0], first.sessions[1].plots[0]);
        assert.strictEqual(appended.sessions[0].plots[0].ops.length, 2);
        assert.deepStrictEqual(first, original);
        history.replaceAtIndex('a', 0, makePlot('resized'));
        const replayed = history.snapshot();
        assert.strictEqual(replayed.sessions[0].plots[0].device.bg, 'resized');
        assert.strictEqual(appended.sessions[0].plots[0].device.bg, 'A');
        history.restoreDeviceIdentity('a', 'new-a', owner);
        history.invalidateReplayIndices('new-a');
        const reconnected = history.snapshot().sessions.find((entry) => entry.id === 'new-a')!;
        assert.strictEqual(reconnected.plots[0].sessionId, 'new-a');
        assert.strictEqual(reconnected.plots[0].rIndex, undefined);
        assert.strictEqual(replayed.sessions[0].plots[0].sessionId, 'a');
        assert.strictEqual(replayed.sessions[0].plots[0].rIndex, 0);
        const restored = new PlotHistory();
        restored.restore(first);
        restored.appendOps('a', makePlot('more'));
        assert.deepStrictEqual(
            first,
            original,
            'restoration must not share mutable geometry with storage',
        );
    });

    suite('events', () => {
        test('restores each session navigation independently from reload state', () => {
            history.addPlot('a', makePlot('A1'));
            history.addPlot('a', makePlot('A2'));
            history.removeCurrent();
            history.setSessionLabel('a', 'r-123-1');
            history.addPlot('b', makePlot('B1'));
            history.addPlot('b', makePlot('B2'));
            history.navigatePrevious();
            const restored = new PlotHistory();
            restored.restore(JSON.parse(JSON.stringify(history.snapshot())) as unknown);
            assert.strictEqual(restored.getActiveSessionId(), 'b');
            assert.strictEqual(restored.sessionLabel('a'), 'r-123-1');
            assert.strictEqual(restored.isLatestDeleted('a'), true);
            restored.addPlot('new-device', makePlot('new'));
            assert.strictEqual(restored.getActiveSessionId(), 'new-device');
            assert.strictEqual(restored.currentPlot('a')?.device.bg, 'A1');
            assert.strictEqual(restored.currentPlot('b')?.device.bg, 'B1');
            assert.strictEqual(restored.navigateNext('b')?.device.bg, 'B2');
        });

        test('restoration ignores invalid frames and applies the current history limit', () => {
            const restored = new PlotHistory(1);
            restored.restore({
                activeSessionId: 'bad',
                sessions: [
                    { id: 'bad', plots: [null], currentIndex: 0, latestDeleted: false },
                    {
                        id: 'valid',
                        plots: [makePlot('old'), makePlot('latest')],
                        currentIndex: 0,
                        latestDeleted: false,
                    },
                ],
            });
            assert.deepStrictEqual(restored.sessionIds(), ['valid']);
            assert.strictEqual(restored.count(), 1);
            assert.strictEqual(restored.currentPlot()?.device.bg, 'latest');
        });

        test('emits change on addPlot', () => {
            let fired = 0;
            history.onDidChange(() => fired++);
            history.addPlot('s1', makePlot('A'));
            assert.strictEqual(fired, 1);
        });

        test('emits change on navigation', () => {
            history.addPlot('s1', makePlot('A'));
            history.addPlot('s1', makePlot('B'));
            let fired = 0;
            history.onDidChange(() => fired++);
            history.navigatePrevious();
            history.navigateNext();
            assert.strictEqual(fired, 2);
        });

        test('does not emit change when replaceLatest is rejected', () => {
            history.addPlot('s1', makePlot('A'));
            history.removeCurrent();
            let fired = 0;
            history.onDidChange(() => fired++);
            history.replaceLatest('s1', makePlot('stale'));
            assert.strictEqual(fired, 0);
        });
    });
});
