import * as assert from 'assert';
import * as cheerio from 'cheerio';
import { plotToSvg } from '../../interactive/plotSvg';
import { assertSvgTextVisible } from '../svgAssertions';

suite('Interactive SVG rendering', () => {
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

    test('raster images fill their R device rectangle instead of preserving pixel aspect ratio', () => {
        const svg = render([{ op: 'raster', x: 10, y: 180, w: 25, h: 150, data: 'data:image/png;base64,AAAA' }]);
        const $ = cheerio.load(svg, { xmlMode: true });
        assert.strictEqual($('image').attr('width'), '25');
        assert.strictEqual($('image').attr('height'), '150');
        assert.strictEqual($('image').attr('preserveAspectRatio'), 'none');
    });

    test('zero-height and zero-width bars retain their border lines', () => {
        const $ = cheerio.load(render([
            { op: 'rect', x0: 20, y0: 50, x1: 80, y1: 50, gc: { col: 'black', fill: 'grey' } },
            { op: 'rect', x0: 90, y0: 20, x1: 90, y1: 80, gc: { col: 'red', fill: 'grey' } },
        ]), { xmlMode: true });
        assert.strictEqual($('line').length, 2);
        assert.deepStrictEqual($('line').toArray().map(line => [
            $(line).attr('x1'), $(line).attr('y1'), $(line).attr('x2'), $(line).attr('y2'), $(line).attr('stroke'),
        ]), [['20', '50', '80', '50', 'black'], ['90', '20', '90', '80', 'red']]);
    });

    test('rasters rotate about the R anchor, reflect signed extents and preserve interpolation', () => {
        for (const w of [40, -40]) {
            for (const h of [60, -60]) {
                for (const interpolate of [true, false]) {
                    const svg = render([{ op: 'raster', x: 50, y: 100, w, h, rot: 30,
                        interpolate, data: 'data:image/png;base64,AAAA' }]);
                    const $ = cheerio.load(svg, { xmlMode: true });
                    assert.strictEqual($('image').attr('x'), '0');
                    assert.strictEqual($('image').attr('y'), '-60');
                    assert.strictEqual($('image').attr('transform'),
                        `translate(50 100) rotate(-30) scale(${Math.sign(w)} ${-Math.sign(h)})`);
                    assert.strictEqual($('image').attr('image-rendering'), interpolate ? 'auto' : 'pixelated');
                }
            }
        }
    });

    test('R point sizes are converted to device pixels for each plot DPI', () => {
        for (const dpi of [72, 96, 144]) {
            const svg = plotToSvg({ version: 1, sessionId: 'test',
                device: { width: 200, height: 200, dpi, bg: 'white' },
                ops: [{ ...title('Twelve points'), gc: { col: 'black', font: { size: 12 } } }] });
            const $ = cheerio.load(svg, { xmlMode: true });
            assert.strictEqual(Number($('text').attr('font-size')), dpi / 6);
        }
    });
});
