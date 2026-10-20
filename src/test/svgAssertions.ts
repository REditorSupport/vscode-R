import * as assert from 'assert';
import * as cheerio from 'cheerio';

/** Check rendered clipping, rather than merely finding hidden text in the SVG. */
export function assertSvgTextVisible(svg: string, label: string, count = 1): void {
    const $ = cheerio.load(svg, { xmlMode: true });
    const matches = $('text').filter((_, element) => $(element).text() === label);
    assert.strictEqual(matches.length, count, `Expected ${count} occurrences of ${label}`);
    matches.each((_, element) => {
        const position = /translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)/.exec(
            $(element).attr('transform') ?? '',
        );
        const x = Number($(element).attr('x') ?? 0) + Number(position?.[1] ?? 0);
        const y = Number($(element).attr('y') ?? 0) + Number(position?.[2] ?? 0);
        assert.ok(Number.isFinite(x) && Number.isFinite(y), `Invalid text position for ${label}`);
        $(element)
            .parents('[clip-path]')
            .each((_, ancestor) => {
                const id = /^url\(#(.+)\)$/.exec($(ancestor).attr('clip-path') ?? '')?.[1];
                assert.ok(id, `Missing clip reference for ${label}`);
                const rect = $(`clipPath[id="${id}"] > rect`);
                assert.strictEqual(rect.length, 1);
                const left = Number(rect.attr('x')),
                    top = Number(rect.attr('y'));
                const right = left + Number(rect.attr('width')),
                    bottom = top + Number(rect.attr('height'));
                assert.ok(
                    x >= left && x <= right && y >= top && y <= bottom,
                    `${label} at (${x}, ${y}) is hidden by clip ${id}: (${left}, ${top})–(${right}, ${bottom})`,
                );
            });
    });
}
