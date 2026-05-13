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
                version: 1, sessionId: '', ops: [{ op: 'line', label: 'extra' }],
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
                version: 1, sessionId: '', ops: [{ op: 'line' }],
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
                version: 1, sessionId: '', ops: [{ op: 'line' }],
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

    suite('events', () => {
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
