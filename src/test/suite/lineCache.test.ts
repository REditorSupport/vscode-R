import * as assert from 'assert';

import { cleanLine } from '../../lineCache';

// Defines a Mocha test suite to group tests of similar kind together
suite('lineCache Tests', () => {
    test('cleanLine', () => {
        assert.strictEqual(cleanLine('abcde  '), 'abcde');
        assert.strictEqual(cleanLine('abcde  "abc"  '), 'abcde  "abc"');
        assert.strictEqual(cleanLine('abcde  #abd'), 'abcde');
        assert.strictEqual(cleanLine('abcde  "#abd"  # jr2 2r'), 'abcde  "#abd"');
        assert.strictEqual(cleanLine('abcde  "\'#abd\'"  #jr 22r" '), 'abcde  "\'#abd\'"');
    });

    test('escaped quotes keep hashes inside strings and strip trailing comments', () => {
        assert.strictEqual(cleanLine(String.raw`x <- "a\"#b" # comment`), String.raw`x <- "a\"#b"`);
        assert.strictEqual(cleanLine(String.raw`x <- 'a\'#b' # comment`), String.raw`x <- 'a\'#b'`);
        assert.strictEqual(cleanLine('x <- `a\\`#b` # comment'), 'x <- `a\\`#b`');
        assert.strictEqual(cleanLine(String.raw`x <- "a\\" # comment`), String.raw`x <- "a\\"`);
    });
});
