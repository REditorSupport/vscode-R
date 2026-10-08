import * as assert from 'assert';
import { ArfOutput } from '../../interactive/backends/arfOutput';

suite('arf output framing', () => {
    test('separates fragmented control references from Unicode and marker-like console text', () => {
        const result: unknown[] = [];
        const parser = new ArfOutput('secret', text => { if (text) { result.push(text); } }, event => result.push(event));
        const frame = `\x1esecret:${Buffer.from(JSON.stringify({ type: 'event', eventId: 7 })).toString('base64')}\x1f`;
        parser.push('λ🙂\x1eother:text');
        for (const character of frame) { parser.push(character); }
        parser.push('tail');
        assert.deepStrictEqual(result, ['λ🙂\x1eother:text', { type: 'event', eventId: 7 }, 'tail']);
    });
    test('rejects malformed authenticated frames without interpreting them as output', () => {
        const parser = new ArfOutput('secret', () => assert.fail('No console output'), () => assert.fail('No event'));
        assert.throws(() => parser.push('\x1esecret:not base64\x1f'), /Invalid arf event/);
    });
});
