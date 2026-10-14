import * as assert from 'assert';
import { liveSignature } from '../../signatureHelp';

suite('Live R function signatures', () => {
    const summaries = { fun1: { type: 'closure', str: 'function (x, y = c(1, 2), ..., exact = "a,b")' } };
    test('retains default expressions and labels the active positional argument', () => {
        const help = liveSignature('fun1(1, ', summaries);
        assert.ok(help);
        assert.strictEqual(help.label, 'fun1(x, y = c(1, 2), ..., exact = "a,b")');
        assert.strictEqual(help.activeParameter, 1);
        assert.deepStrictEqual(help.parameters.map(range => help.label.slice(...range)), ['x', 'y = c(1, 2)', '...', 'exact = "a,b"']);
    });
    test('ignores nested calls, indexing, strings, raw strings, and comments when counting arguments', () => {
        for (const code of ['fun1(list(a = 1, b = 2), ', 'fun1(x[1, 2], ', String.raw`fun1("a,\"(", `,
            'fun1(r"-(a,"b,(,)-", ', 'fun1(1, # a misleading fn(,\n']) {
            assert.strictEqual(liveSignature(code, summaries)?.activeParameter, 1, code);
        }
        assert.strictEqual(liveSignature('fun1(1); # fun1(,\nfun1(', summaries)?.activeParameter, 0);
    });
    test('matches named arguments before assigning positional arguments and handles dots', () => {
        assert.strictEqual(liveSignature('fun1(y = 2, ', summaries)?.activeParameter, 0);
        assert.strictEqual(liveSignature('fun1(1, 2, extra = ', summaries)?.activeParameter, 2);
        assert.strictEqual(liveSignature('fun1(1, exact = ', summaries)?.activeParameter, 3);
        assert.strictEqual(liveSignature('fun1(1, ex = ', summaries)?.activeParameter, 2, 'R does not partially match names after ...');
        assert.strictEqual(liveSignature('fn(be = ', { fn: { type: 'closure', str: 'function (alpha, beta)' } })?.activeParameter, 1);
    });
    test('supports multiline calls and quoted or Unicode function names', () => {
        const help = liveSignature('`my function`(\n1, ', { 'my function': { type: 'closure', str: 'function (x, y)' } });
        assert.strictEqual(help?.label, '`my function`(x, y)');
        assert.strictEqual(help?.activeParameter, 1);
        assert.strictEqual(liveSignature('函数(', { 函数: { type: 'closure', str: 'function (x)' } })?.label, '函数(x)');
    });
    test('defers unknown, qualified, nested, closed, invalid, and truncated calls', () => {
        for (const code of ['unknown(', 'pkg::fun1(', 'pkg:::fun1(', 'obj$fun1(', 'obj@fun1(', 'fun1(list(', 'fun1()', 'fun1(]']) {
            assert.strictEqual(liveSignature(code, summaries), undefined, code);
        }
        assert.strictEqual(liveSignature('fun1(', { fun1: { type: 'closure', str: 'function (x, ...' } }), undefined);
        assert.strictEqual(liveSignature('fun1(', { fun1: { type: 'double', str: 'num 1' } }), undefined);
    });
});
