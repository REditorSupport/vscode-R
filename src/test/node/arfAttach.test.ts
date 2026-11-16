import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
    ArfRpcError,
    ArfTransportTimeoutError,
    arfVersionAtLeast,
    checkArfSession,
} from '../../interactive/arf';
import { ArfAttachConnection, ArfEvent } from '../../interactive/arfAttach';
import { INSPECTION_METHODS } from '../../interactive/backend';
import {
    CallLimits,
    INSPECTION_SELECTORS,
    InspectionCalls,
    InspectionError,
    InspectionFailure,
    decodeInspectionResult,
    exposeInspectionExpression,
    inspectionCallsAvailable,
    inspectionFailure,
    parseHandlerApi,
} from '../../interactive/backends/arfInspection';

/** A fake arf server that hands each parsed line to `handle`. */
function fakeArf(
    handle: (message: Record<string, unknown>, socket: net.Socket) => void,
): Promise<{ endpoint: string; server: net.Server; dispose(): void }> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r-arf-attach-'));
    // arf listens on a named pipe on Windows and a Unix socket elsewhere.
    const endpoint =
        process.platform === 'win32'
            ? `\\\\.\\pipe\\${path.basename(directory)}`
            : path.join(directory, 'arf.sock');
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk.toString();
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                handle(JSON.parse(line) as Record<string, unknown>, socket);
            }
        });
        socket.on('error', () => undefined);
    });
    return new Promise((resolve) =>
        server.listen(endpoint, () =>
            resolve({
                endpoint,
                server,
                dispose() {
                    sockets.forEach((socket) => socket.destroy());
                    server.close();
                    fs.rmSync(directory, { recursive: true, force: true });
                },
            }),
        ),
    );
}

const line = (message: unknown): string => JSON.stringify(message) + '\n';
async function until(predicate: () => boolean, timeout = 3000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error('Timed out waiting for the fake arf');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
const attachResult = {
    connection_id: 3,
    api_version: 1,
    capabilities: ['events', 'call_execution_timeout'],
    session_id: 'session-a',
    session: { arf_version: '0.7.1', capabilities: ['call_execution_timeout'] },
};

suite('arf attach connection', () => {
    test('delivers an event that arrives in the same chunk as the attach response', async () => {
        const arf = await fakeArf((message, socket) => {
            if (message.method === 'attach') {
                socket.write(
                    line({ jsonrpc: '2.0', id: message.id, result: attachResult }) +
                        line({
                            jsonrpc: '2.0',
                            method: 'event',
                            params: {
                                seq: 9,
                                topic: 'demo.started',
                                data: { id: 'a' },
                                execution: 7,
                            },
                        }),
                );
            }
        });
        try {
            const events: ArfEvent[] = [];
            const { connection, result } = await ArfAttachConnection.open(arf.endpoint, {
                subscribe: ['demo.*'],
                onEvent: (event) => events.push(event),
            });
            assert.strictEqual(result.sessionId, 'session-a');
            assert.strictEqual(result.session.arf_version, '0.7.1');
            await new Promise((resolve) => setImmediate(resolve));
            assert.deepStrictEqual(events, [
                { seq: 9, topic: 'demo.started', data: { id: 'a' }, execution: 7 },
            ]);
            connection.close();
        } finally {
            arf.dispose();
        }
    });

    test('matches responses by ID and keeps RPC error codes and data', async () => {
        const held: Record<string, unknown>[] = [];
        const arf = await fakeArf((message, socket) => {
            if (message.method === 'attach') {
                socket.write(line({ jsonrpc: '2.0', id: message.id, result: attachResult }));
            } else {
                held.push(message);
                if (held.length === 2) {
                    // Answer in reverse order, the second one with an error.
                    socket.write(
                        line({
                            jsonrpc: '2.0',
                            id: held[1].id,
                            error: {
                                code: -32007,
                                message: 'Request timed out',
                                data: { execution_id: 4 },
                            },
                        }) + line({ jsonrpc: '2.0', id: held[0].id, result: { first: true } }),
                    );
                }
            }
        });
        try {
            const { connection } = await ArfAttachConnection.open(arf.endpoint);
            const first = connection.request('session');
            const second = connection.request('evaluate', { code: '1' }).then(
                () => assert.fail('expected an RPC error'),
                (error: unknown) => error,
            );
            assert.deepStrictEqual(await first, { first: true });
            const error = (await second) as ArfRpcError;
            assert.ok(error instanceof ArfRpcError);
            assert.strictEqual(error.code, -32007);
            assert.strictEqual(error.rpcMessage, 'Request timed out');
            assert.deepStrictEqual(error.data, { execution_id: 4 });
            connection.close();
        } finally {
            arf.dispose();
        }
    });

    test('ignores a late response after a local timeout and never reuses its ID', async () => {
        const ids: unknown[] = [];
        let late: (() => void) | undefined;
        const arf = await fakeArf((message, socket) => {
            if (message.method === 'attach') {
                socket.write(line({ jsonrpc: '2.0', id: message.id, result: attachResult }));
                return;
            }
            ids.push(message.id);
            if (message.method === 'slow') {
                late = () => socket.write(line({ jsonrpc: '2.0', id: message.id, result: 'late' }));
            } else {
                late?.();
                socket.write(line({ jsonrpc: '2.0', id: message.id, result: 'fresh' }));
            }
        });
        try {
            const { connection } = await ArfAttachConnection.open(arf.endpoint);
            await assert.rejects(
                connection.request('slow', {}, { timeout: 20 }),
                ArfTransportTimeoutError,
            );
            assert.strictEqual(await connection.request('fast'), 'fresh');
            assert.notStrictEqual(ids[0], ids[1]);
            assert.strictEqual(connection.closed, undefined);
            connection.close();
        } finally {
            arf.dispose();
        }
    });

    test('closes once, rejecting pending and later requests with the same reason', async () => {
        const arf = await fakeArf((message, socket) => {
            if (message.method === 'attach') {
                socket.write(line({ jsonrpc: '2.0', id: message.id, result: attachResult }));
            } else {
                socket.destroy();
            }
        });
        try {
            const closes: Error[] = [];
            const { connection } = await ArfAttachConnection.open(arf.endpoint, {
                onClose: (reason) => closes.push(reason),
            });
            const pending = connection.request('evaluate').then(
                () => assert.fail('expected the request to fail'),
                (error: Error) => error,
            );
            const reason = await pending;
            assert.strictEqual(closes.length, 1);
            assert.strictEqual(closes[0], reason);
            assert.strictEqual(connection.closed, reason);
            await assert.rejects(connection.request('session'), (error) => error === reason);
            connection.close();
            assert.strictEqual(closes.length, 1);
        } finally {
            arf.dispose();
        }
    });

    test('rejects a refused attach with its RPC error', async () => {
        const arf = await fakeArf((message, socket) => {
            socket.end(
                line({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32602, message: 'unsupported protocol', data: null },
                }),
            );
        });
        try {
            await assert.rejects(
                ArfAttachConnection.open(arf.endpoint),
                (error) => error instanceof ArfRpcError && error.code === -32602,
            );
        } finally {
            arf.dispose();
        }
    });
});

suite('arf version requirement', () => {
    test('compares release versions and treats prereleases as older', () => {
        assert.ok(arfVersionAtLeast('0.7.1', '0.7.1'));
        assert.ok(arfVersionAtLeast('0.7.2', '0.7.1'));
        assert.ok(arfVersionAtLeast('0.10.0', '0.7.1'));
        assert.ok(arfVersionAtLeast('1.0.0', '0.7.1'));
        assert.ok(arfVersionAtLeast('0.7.2-beta.1', '0.7.1'));
        assert.ok(!arfVersionAtLeast('0.7.1-beta.1', '0.7.1'));
        assert.ok(!arfVersionAtLeast('0.7.0', '0.7.1'));
        assert.ok(!arfVersionAtLeast('0.5.3', '0.7.1'));
        assert.ok(!arfVersionAtLeast(undefined, '0.7.1'));
        assert.ok(!arfVersionAtLeast('0.7', '0.7.1'));
        assert.ok(!arfVersionAtLeast('latest', '0.7.1'));
    });

    test('rejects old sessions and sessions without handler call deadlines', () => {
        checkArfSession({ arf_version: '0.7.1', capabilities: ['call_execution_timeout'] });
        assert.throws(
            () => checkArfSession({ arf_version: '0.5.3', capabilities: [] }),
            /requires arf 0\.7\.1 or later, but the session runs 0\.5\.3/,
        );
        assert.throws(() => checkArfSession({}), /an unknown version/);
        assert.throws(
            () => checkArfSession({ arf_version: '0.7.1', capabilities: [] }),
            /execution deadlines/,
        );
    });
});

/** The `value` of a handler call reply, as sess encodes an inspection result. */
const callReply = (result?: unknown, version = 1) => ({
    value: JSON.stringify(result === undefined ? { version } : { version, result }),
    stdout: '',
    stderr: '',
    execution_id: 1,
});
const rpcFailure = (id: unknown, code: number, message: string, data?: unknown): string =>
    line({ jsonrpc: '2.0', id, error: { code, message, data } });

suite('arf inspection calls', () => {
    /** Runs `InspectionCalls` over a real attach connection to a fake arf. */
    async function withInspection(
        handle: (message: Record<string, unknown>, socket: net.Socket) => void,
        body: (inspection: InspectionCalls, requests: Record<string, unknown>[]) => Promise<void>,
    ): Promise<void> {
        const requests: Record<string, unknown>[] = [];
        const arf = await fakeArf((message, socket) => {
            if (message.method === 'attach') {
                socket.write(line({ jsonrpc: '2.0', id: message.id, result: attachResult }));
            } else {
                requests.push(message);
                handle(message, socket);
            }
        });
        try {
            const { connection } = await ArfAttachConnection.open(arf.endpoint);
            const inspection = new InspectionCalls((selector, args, limits) =>
                connection.request(
                    'call',
                    {
                        handler: selector,
                        args,
                        queue_timeout_ms: limits.queue,
                        execution_timeout_ms: limits.execution,
                    },
                    { timeout: limits.transport },
                ),
            );
            try {
                await body(inspection, requests);
            } finally {
                inspection.close();
                connection.close();
            }
        } finally {
            arf.dispose();
        }
    }
    const reply = (socket: net.Socket, message: Record<string, unknown>, result?: unknown) =>
        socket.write(line({ jsonrpc: '2.0', id: message.id, result: callReply(result) }));
    const params = (message: Record<string, unknown>) => message.params as Record<string, unknown>;
    const failure = (promise: Promise<unknown>): Promise<InspectionError> =>
        promise.then(
            () => assert.fail('expected the inspection to fail'),
            (error: unknown) => {
                assert.ok(error instanceof InspectionError, String(error));
                return error;
            },
        );

    test('calls the published selector with the parameters as one JSON string and the deadline', async () => {
        await withInspection(
            (message, socket) => reply(socket, message, { str: 'x' }),
            async (inspection, requests) => {
                const result = await inspection.request({
                    method: 'hover',
                    params: { expr: 'obj$name' },
                    timeout: 1500,
                });
                assert.deepStrictEqual(result, { str: 'x' });
                assert.strictEqual(requests.length, 1);
                assert.strictEqual(requests[0].method, 'call');
                assert.deepStrictEqual(params(requests[0]), {
                    handler: 'vscode-r.inspect.json/hover',
                    args: '{"expr":"obj$name"}',
                    queue_timeout_ms: 1500,
                    execution_timeout_ms: 1500,
                });
            },
        );
    });

    test('decodes results as the socket delivered them, with NULL as no result', async () => {
        const results = [undefined, null, [], {}, false, 'text', { rows: [[1, null]], n: 2 }];
        let index = 0;
        await withInspection(
            (message, socket) => reply(socket, message, results[index++]),
            async (inspection) => {
                for (const expected of results) {
                    const actual = await inspection.request({
                        method: 'dataview_dispose',
                        params: { view_id: String(index) },
                    });
                    assert.deepStrictEqual(actual, expected);
                }
            },
        );
        assert.strictEqual(decodeInspectionResult(callReply()), undefined);
        assert.strictEqual(decodeInspectionResult(callReply(null)), null);
        assert.throws(() => decodeInspectionResult({ value: 3 }), /not a JSON string/);
        assert.throws(() => decodeInspectionResult({ value: '{' }), /not valid JSON/);
        assert.throws(() => decodeInspectionResult({ value: '[1]' }), /not valid JSON/);
        assert.throws(() => decodeInspectionResult(callReply({}, 2)), /unsupported version/);
    });

    test('distinguishes queue timeout, deadline, R error, interrupt and unpublished handler', async () => {
        const cases: [number, string, unknown, InspectionFailure, RegExp][] = [
            [-32012, 'Handler call expired', { timeout_ms: 7 }, 'queue_timeout', /did not start/],
            [
                -32019,
                'Handler execution exceeded its 7 ms deadline',
                { timeout_ms: 7, class: ['interrupt', 'condition'] },
                'deadline',
                /execution deadline of 7 ms/,
            ],
            [
                -32014,
                'R error',
                { message: 'Unknown dataview id: v', class: ['simpleError', 'error', 'condition'] },
                'r_error',
                /failed: Unknown dataview id: v/,
            ],
            [-32016, 'Interrupted', { class: ['interrupt'] }, 'interrupted', /was interrupted/],
            [-32010, 'No such handler', undefined, 'unpublished', /not published/],
            [-32011, 'Queue full', undefined, 'rejected', /rejected.*Queue full/],
        ];
        let index = 0;
        await withInspection(
            (message, socket) => {
                const [code, text, data] = cases[index++];
                socket.write(rpcFailure(message.id, code, text, data));
            },
            async (inspection) => {
                for (const [, , data, kind, pattern] of cases) {
                    const error = await failure(
                        inspection.request({
                            method: 'dataview_init',
                            params: { view_id: String(index) },
                            timeout: 7,
                        }),
                    );
                    assert.strictEqual(error.kind, kind);
                    assert.match(error.message, pattern);
                    if (data && typeof data === 'object' && 'class' in data) {
                        assert.deepStrictEqual(error.rClass, data.class);
                    }
                }
            },
        );
    });

    test('an R error in hover and completion is no result, and anything else is an error', async () => {
        const codes = [-32014, -32014, -32019, -32016, -32012, -32014];
        let index = 0;
        await withInspection(
            (message, socket) => socket.write(rpcFailure(message.id, codes[index++], 'failed', {})),
            async (inspection) => {
                assert.strictEqual(
                    await inspection.request({ method: 'hover', params: { expr: '1 + 1' } }),
                    null,
                );
                assert.strictEqual(
                    await inspection.request({
                        method: 'completion',
                        params: { expr: '1 + 1', trigger: '$' },
                    }),
                    null,
                );
                // A deadline, an interrupt and a queue timeout stay errors.
                for (const kind of ['deadline', 'interrupted', 'queue_timeout']) {
                    const error = await failure(
                        inspection.request({ method: 'hover', params: { expr: kind } }),
                    );
                    assert.strictEqual(error.kind, kind);
                }
                // Other methods propagate an R error.
                const error = await failure(
                    inspection.request({ method: 'workspace_view', params: { name: 'x' } }),
                );
                assert.strictEqual(error.kind, 'r_error');
            },
        );
    });

    test('waits for the reply that follows a deadline, longer than queue and execution limits', async () => {
        await withInspection(
            (message, socket) => {
                // arf replies only after the handler stopped, which may take a while.
                setTimeout(
                    () => socket.write(rpcFailure(message.id, -32019, 'deadline', { class: [] })),
                    150,
                );
            },
            async (inspection) => {
                const started = Date.now();
                const error = await failure(
                    inspection.request({ method: 'workspace', params: {}, timeout: 50 }),
                );
                assert.strictEqual(error.kind, 'deadline');
                assert.ok(Date.now() - started >= 140);
            },
        );
    });

    test('reports a lost reply as a transport timeout that may still be running', async () => {
        const limits: CallLimits = { queue: 10, execution: 10, transport: 40 };
        const transport = new InspectionCalls(() => Promise.reject(new ArfTransportTimeoutError()));
        const error = await failure(transport.request({ method: 'workspace', params: {} }));
        assert.strictEqual(error.kind, 'transport_timeout');
        assert.match(error.message, /may still be running/);
        assert.strictEqual(
            (inspectionFailure(new ArfTransportTimeoutError(), 'hover', limits) as InspectionError)
                .kind,
            'transport_timeout',
        );
        // Failures that are not arf's replies pass through unchanged.
        const lost = new Error('arf closed the IPC connection');
        assert.strictEqual(inspectionFailure(lost, 'hover', limits), lost);
    });

    test('sends one call at a time and shares identical read-only requests', async () => {
        let socket!: net.Socket;
        await withInspection(
            (_message, connection) => {
                socket = connection;
            },
            async (inspection, requests) => {
                const answer = async (index: number, value: unknown): Promise<void> => {
                    await until(() => requests.length > index);
                    socket.write(
                        line({ jsonrpc: '2.0', id: requests[index].id, result: callReply(value) }),
                    );
                };
                const first = inspection.request({ method: 'workspace', params: { revision: 1 } });
                const same = inspection.request({ method: 'workspace', params: { revision: 1 } });
                const other = inspection.request({ method: 'workspace', params: { revision: 2 } });
                // Not read-only requests: each one runs.
                const dispose = inspection.request({
                    method: 'dataview_dispose',
                    params: { view_id: 'v' },
                });
                const disposeAgain = inspection.request({
                    method: 'dataview_dispose',
                    params: { view_id: 'v' },
                });
                await until(() => requests.length === 1);
                await new Promise((resolve) => setTimeout(resolve, 50));
                assert.strictEqual(requests.length, 1, 'a second call waits for the first reply');
                await answer(0, 'first');
                assert.strictEqual(await first, 'first');
                assert.strictEqual(await same, 'first');
                await answer(1, 'second');
                assert.strictEqual(await other, 'second');
                await answer(2, true);
                assert.strictEqual(await dispose, true);
                await answer(3, true);
                assert.strictEqual(await disposeAgain, true);
                assert.strictEqual(requests.length, 4);
                assert.deepStrictEqual(
                    requests.map((request) => params(request).args),
                    ['{"revision":1}', '{"revision":2}', '{"view_id":"v"}', '{"view_id":"v"}'],
                );
            },
        );
    });

    test('distinct waiting hovers are each answered, as they can come from different clients', async () => {
        let socket!: net.Socket;
        await withInspection(
            (_message, connection) => {
                socket = connection;
            },
            async (inspection, requests) => {
                const running = inspection.request({ method: 'workspace', params: {} });
                await until(() => requests.length === 1);
                const hovers = ['a', 'b'].map((expr) =>
                    inspection.request({ method: 'hover', params: { expr } }),
                );
                socket.write(
                    line({ jsonrpc: '2.0', id: requests[0].id, result: callReply('done') }),
                );
                assert.strictEqual(await running, 'done');
                for (const [index, expr] of ['a', 'b'].entries()) {
                    await until(() => requests.length === index + 2);
                    socket.write(
                        line({
                            jsonrpc: '2.0',
                            id: requests[index + 1].id,
                            result: callReply({ str: expr }),
                        }),
                    );
                    assert.deepStrictEqual(await hovers[index], { str: expr });
                }
                assert.deepStrictEqual(
                    requests.map((request) => params(request).args),
                    ['{}', '{"expr":"a"}', '{"expr":"b"}'],
                );
            },
        );
    });

    test('a request that waits as long as its timeout fails without being sent', async () => {
        let socket!: net.Socket;
        await withInspection(
            (_message, connection) => {
                socket = connection;
            },
            async (inspection, requests) => {
                const running = inspection.request({
                    method: 'workspace',
                    params: {},
                    timeout: 5000,
                });
                await until(() => requests.length === 1);
                const error = await failure(
                    inspection.request({
                        method: 'workspace_view',
                        params: { name: 'x' },
                        timeout: 40,
                    }),
                );
                assert.strictEqual(error.kind, 'queue_timeout');
                assert.match(error.message, /waited 40 ms/);
                socket.write(line({ jsonrpc: '2.0', id: requests[0].id, result: callReply(1) }));
                assert.strictEqual(await running, 1);
                await new Promise((resolve) => setTimeout(resolve, 30));
                assert.strictEqual(requests.length, 1, 'the expired request is never sent');
            },
        );
    });

    test('bounds how many requests wait and fails them when closed', async () => {
        await withInspection(
            () => undefined,
            async (inspection, requests) => {
                const first = inspection.request({
                    method: 'dataview_init',
                    params: { view_id: '0' },
                });
                await until(() => requests.length === 1);
                const waiting = Array.from({ length: 32 }, (_, index) =>
                    inspection.request({
                        method: 'dataview_init',
                        params: { view_id: String(index + 1) },
                    }),
                );
                const overflow = await failure(
                    inspection.request({ method: 'dataview_init', params: { view_id: 'more' } }),
                );
                assert.strictEqual(overflow.kind, 'overloaded');
                inspection.close(new Error('closed for the test'));
                for (const promise of waiting) {
                    await assert.rejects(promise, /closed for the test/);
                }
                await assert.rejects(
                    inspection.request({ method: 'workspace', params: {} }),
                    /closed for the test/,
                );
                void first.catch(() => undefined);
            },
        );
    });
});

suite('arf inspection handlers', () => {
    const handlers = (names: string[], state = 'locked') => ({ state, handlers: names });

    test('publishes ten selectors in one namespace, and none for socket-only methods', () => {
        assert.strictEqual(INSPECTION_SELECTORS.length, 10);
        assert.strictEqual(new Set(INSPECTION_SELECTORS).size, 10);
        assert.ok(INSPECTION_SELECTORS.every((name) => name.startsWith('vscode-r.inspect.json/')));
        assert.deepStrictEqual(
            INSPECTION_SELECTORS,
            INSPECTION_METHODS.map((method) => `vscode-r.inspect.json/${method}`),
        );
        for (const method of ['interactive_stop', 'plot_latest']) {
            assert.ok(!INSPECTION_SELECTORS.some((name) => name.endsWith(`/${method}`)));
        }
    });

    test('a managed session always calls; an adopted one only with every selector locked', () => {
        assert.ok(inspectionCallsAvailable(false, undefined));
        assert.ok(inspectionCallsAvailable(false, handlers([], 'unexposed')));
        assert.ok(inspectionCallsAvailable(true, handlers([...INSPECTION_SELECTORS, 'demo/add'])));
        assert.ok(!inspectionCallsAvailable(true, undefined));
        assert.ok(!inspectionCallsAvailable(true, handlers([], 'unexposed')));
        assert.ok(!inspectionCallsAvailable(true, handlers([...INSPECTION_SELECTORS], 'revoked')));
        assert.ok(
            !inspectionCallsAvailable(true, handlers([...INSPECTION_SELECTORS], 'unexposed')),
        );
        assert.ok(!inspectionCallsAvailable(true, handlers(INSPECTION_SELECTORS.slice(1))));
        assert.ok(
            !inspectionCallsAvailable(
                true,
                handlers(INSPECTION_SELECTORS.map((name) => name.replace('.json', '.other'))),
            ),
        );
    });

    test('reads the handler table of a session', () => {
        assert.deepStrictEqual(
            parseHandlerApi({ handler_api: { state: 'locked', handlers: ['a/b', 3, 'c/d'] } }),
            { state: 'locked', handlers: ['a/b', 'c/d'] },
        );
        assert.strictEqual(parseHandlerApi({}), undefined);
        assert.strictEqual(parseHandlerApi({ handler_api: [] }), undefined);
        assert.strictEqual(parseHandlerApi({ handler_api: { state: 'locked' } }), undefined);
    });

    test('the published expression sources the installed table without loading sess', () => {
        const expression = exposeInspectionExpression(path.join('/lib with "quote"', 'x'));
        assert.match(expression, /^base::source\(/);
        assert.ok(
            expression.includes(
                JSON.stringify(
                    path.join('/lib with "quote"', 'x', 'sess', 'arf', 'expose-inspection.R'),
                ),
            ),
        );
        assert.ok(
            expression.endsWith(`$value(${JSON.stringify(path.join('/lib with "quote"', 'x'))})`),
        );
        assert.ok(!/loadNamespace|library\(|requireNamespace/.test(expression));
    });
});
