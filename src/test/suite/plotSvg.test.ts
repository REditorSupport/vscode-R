import * as assert from 'assert';
import * as cheerio from 'cheerio';
import { plotToSvg } from '../../interactive/plotSvg';
import { assertSvgTextVisible } from '../svgAssertions';

suite('Interactive SVG clipping', () => {
    const small = { op: 'clip', x0: 50, y0: 50, x1: 150, y1: 150 };
    const large = { op: 'clip', x0: 0, y0: 0, x1: 200, y1: 200 };
    const title = (str: string) => ({ op: 'text', x: 100, y: 20, str, gc: { col: 'black' } });
    const render = (ops: unknown[]): string => plotToSvg({ version: 1, sessionId: 'test',
        device: { width: 200, height: 200, dpi: 96, bg: 'white' }, ops });

    test('expanding the clip inside an execution group reveals titles outside the plot region', () => {
        const svg = render([small, { op: 'beginGroup', ext: { executionId: 'cell' } }, large, title('Panel title'), { op: 'endGroup' }]);
        assertSvgTextVisible(svg, 'Panel title');
    });

    test('nested groups inherit and restore clips without splitting opacity groups', () => {
        const svg = render([large, { op: 'beginGroup', ext: { opacity: 0.5 } }, small,
            title('Clipped before child'), { op: 'beginGroup', ext: { opacity: 0.25 } },
            title('Inherited clip'), large, title('Visible in child'), { op: 'endGroup' },
            title('Restored parent clip'), { op: 'endGroup' }, title('Restored root clip')]);
        assertSvgTextVisible(svg, 'Visible in child');
        assertSvgTextVisible(svg, 'Restored root clip');
        for (const label of ['Clipped before child', 'Inherited clip', 'Restored parent clip']) {
            assert.throws(() => assertSvgTextVisible(svg, label), /is hidden by clip/);
        }
        const $ = cheerio.load(svg, { xmlMode: true });
        assert.strictEqual($('g[opacity="0.5"]').length, 1);
        assert.strictEqual($('g[opacity="0.25"]').length, 1);
        assert.strictEqual($('g[opacity="0.25"]').parents('g[opacity="0.5"]').length, 1);
    });

    test('ending an unmatched group leaves clipping intact and an unfinished group is closed', () => {
        const svg = render([small, { op: 'endGroup' }, title('Still clipped'),
            { op: 'beginGroup' }, large, title('Visible in unfinished group')]);
        assert.throws(() => assertSvgTextVisible(svg, 'Still clipped'), /is hidden by clip/);
        assertSvgTextVisible(svg, 'Visible in unfinished group');
        assert.strictEqual((svg.match(/<g\b/g) ?? []).length, (svg.match(/<\/g>/g) ?? []).length);
    });
});
