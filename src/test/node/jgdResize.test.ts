import * as assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PlotHistory } from '../../plotViewer/jgdPlotHistory';
import { JgdSocketServer } from '../../plotViewer/jgdSocketServer';

const run = promisify(execFile);

async function until(read: () => boolean): Promise<void> {
    const deadline = Date.now() + 10000;
    while (!read()) {
        if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for JGD to resize while R is idle');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

suite('Live JGD resize', () => {
    test('a large plot reaches the latest dimensions without navigation or manual polling', async function () {
        try {
            const probe = await run('Rscript', [
                '--vanilla',
                '-e',
                'cat(requireNamespace("jgd", quietly=TRUE))',
            ]);
            if (probe.stdout.trim() !== 'TRUE') {
                this.skip();
            }
        } catch {
            this.skip();
        }
        const history = new PlotHistory();
        const server = new JgdSocketServer(history);
        let desired = { width: 846, height: 667 };
        const replays: Array<{ width: number; height: number }> = [];
        server.setMeasureText((request) =>
            Promise.resolve({
                type: 'metrics_response',
                id: request.id,
                width: 8,
                ascent: 8,
                descent: 2,
            }),
        );
        server.setOnFrame((id, message) => {
            const plot = history.currentPlot(id)!;
            if (message.resizeReplay) {
                replays.push({ width: plot.device.width, height: plot.device.height });
            }
            if (plot.device.width !== desired.width || plot.device.height !== desired.height) {
                server.handleResize(desired.width, desired.height, id);
            }
        });
        await new Promise<void>((resolve) => {
            server.onReady(resolve);
            server.start();
        });
        // An interactive process exercises JGD's native idle input handler.
        // No C_jgd_poll_resize call or subsequent R command drives the redraw.
        const r = spawn('R', ['--vanilla', '--slave', '--interactive'], {
            env: { ...process.env, JGD_SOCKET: server.getSocketPath() },
        });
        let errors = '';
        r.stderr.on('data', (data: Buffer) => {
            errors += data.toString();
        });
        r.stdout.resume();
        const exited = new Promise<void>((resolve) => r.once('exit', () => resolve()));
        try {
            r.stdin.write('jgd::jgd(); plot(1:10000)\n');
            await until(
                () =>
                    history.currentPlot()?.device.width === desired.width &&
                    history.currentPlot()?.device.height === desired.height,
            );
            assert.ok(history.currentPlot()!.ops.length >= 10000);
            const id = history.getActiveSessionId();
            replays.length = 0;
            desired = { width: 900, height: 650 };
            server.handleResize(700, 500, id);
            server.handleResize(800, 550, id);
            server.handleResize(desired.width, desired.height, id);
            await until(
                () =>
                    history.currentPlot()?.device.width === desired.width &&
                    history.currentPlot()?.device.height === desired.height,
            );
            assert.deepStrictEqual(replays, [{ width: 700, height: 500 }, desired]);
            assert.strictEqual(history.count(), 1);
            assert.ok(history.currentPlot()!.ops.length >= 10000);
        } catch (error) {
            throw new Error(`${String(error)}\n${errors}`);
        } finally {
            r.kill();
            server.stop();
            await exited;
        }
    });
});
