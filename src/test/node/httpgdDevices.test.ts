import * as assert from 'node:assert/strict';
import * as sinon from 'sinon';
import { HttpgdClient, HttpgdPlotsResponse } from '../../plotViewer/httpgdClient';
import { HttpgdDevices } from '../../plotViewer/httpgdDevices';

suite('httpgd session history', () => {
    let sandbox: sinon.SinonSandbox;
    let session: HttpgdDevices;
    let clients: HttpgdClient[];
    let updates: Map<HttpgdClient, (snapshot: HttpgdPlotsResponse) => void>;
    let bytes: sinon.SinonStub;
    let remove: sinon.SinonStub;
    let disconnect: sinon.SinonStub;

    setup(async () => {
        sandbox = sinon.createSandbox();
        clients = [];
        updates = new Map();
        sandbox.stub(HttpgdClient.prototype, 'onPlotsChanged').callsFake(function (
            this: HttpgdClient,
            callback,
        ) {
            clients.push(this);
            updates.set(this, callback);
        });
        sandbox.stub(HttpgdClient.prototype, 'connect').resolves();
        disconnect = sandbox.stub(HttpgdClient.prototype, 'disconnect');
        bytes = sandbox
            .stub(HttpgdClient.prototype, 'getPlotBytes')
            .resolves(Buffer.from('<svg/>'));
        remove = sandbox.stub(HttpgdClient.prototype, 'removePlot').resolves();
        session = new HttpgdDevices('http://localhost:1234', 'first');
        await session.connect();
    });
    teardown(() => {
        session.disconnect();
        sandbox.restore();
    });

    function publish(index: number, ids: string[]) {
        updates.get(clients[index])!({
            state: { upid: 1, hsize: ids.length, active: true },
            plots: ids.map((id) => ({ id })),
        });
    }

    test('interleaves devices, disambiguates IDs and routes render/export/remove to their owners', async () => {
        publish(0, ['1']);
        await session.addDevice('http://localhost:1235', 'second');
        publish(1, ['1']);
        publish(0, ['1', '2']);
        const ids = session.getPlots().map((plot) => plot.id);
        assert.equal(new Set(ids).size, 3);
        for (const [index, client, rawId] of [
            [0, 0, '1'],
            [1, 1, '1'],
            [2, 0, '2'],
        ] as const) {
            await session.getPlotBytes({
                id: ids[index],
                renderer: 'png',
                width: 900,
                height: 700,
            });
            assert.equal(bytes.lastCall.thisValue, clients[client]);
            assert.deepEqual(bytes.lastCall.args[0], {
                id: rawId,
                renderer: 'png',
                ...(client === 1
                    ? { width: undefined, height: undefined, zoom: undefined }
                    : { width: 900, height: 700 }),
            });
        }
        assert.equal(session.plotConnection(ids[1]).token, 'second');
        await session.removePlot({ id: ids[1] });
        assert.equal(remove.lastCall.thisValue, clients[1]);
        assert.deepEqual(remove.lastCall.args, [{ id: '1' }]);
        publish(1, []);
        assert.deepEqual(
            session.getPlots().map((plot) => plot.id),
            [ids[0], ids[2]],
        );
    });

    test('replacement cannot reuse hidden IDs or deliver late frames into the session', async () => {
        publish(0, ['1']);
        await session.addDevice('http://localhost:1235', 'second');
        publish(1, ['1']);
        const before = session.getPlots();
        await session.addDevice('http://localhost:1235', 'replacement');
        sinon.assert.calledOn(disconnect, clients[1]);
        publish(1, ['1', 'stale']);
        assert.deepEqual(session.getPlots(), [before[0]]);
        publish(2, ['1']);
        const after = session.getPlots();
        assert.equal(after.length, 2);
        assert.notEqual(after[1].id, before[1].id);
        await session.getPlotText({ id: after[1].id });
        assert.equal(bytes.lastCall.thisValue, clients[2]);
        assert.equal(session.plotConnection(after[1].id).token, 'replacement');
    });

    test('reconnect retains stable IDs and order and marks each initial device snapshot as restoring', async () => {
        const events: boolean[] = [];
        session.onPlotsChanged((_plots, restoring) => events.push(restoring));
        publish(0, ['1']);
        await session.addDevice('http://localhost:1235', 'second');
        publish(1, ['1']);
        const before = session.getPlots();
        session.disconnect();
        publish(0, ['ignored']);
        assert.deepEqual(session.getPlots(), before);
        await session.connect();
        publish(1, ['1']);
        publish(0, ['1']);
        assert.deepEqual(session.getPlots(), before);
        assert.deepEqual(events.slice(-2), [true, true]);
        publish(0, ['1', '2']);
        assert.equal(events.at(-1), false);
    });

    test('device selection notifications do not rerender unchanged plots', () => {
        const changes: ReadonlySet<string>[] = [];
        session.onPlotsChanged((_plots, _restoring, changed) => changes.push(changed));
        publish(0, ['1']);
        updates.get(clients[0])!({
            state: { upid: 1, hsize: 1, active: false },
            plots: [{ id: '1' }],
        });
        assert.equal(changes.at(-1)!.size, 0);
        updates.get(clients[0])!({
            state: { upid: 2, hsize: 1, active: true },
            plots: [{ id: '1' }],
        });
        assert.deepEqual([...changes.at(-1)!], ['1']);
    });
});
