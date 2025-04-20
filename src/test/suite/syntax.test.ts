'use strict';

import { readFileSync } from 'fs';
import { join } from 'path';
import * as assert from 'assert';

interface syntaxFile {
    'repository': {
        'function-declarations': {
            'patterns': [
                {
                    'begin':string
                }
            ]
        }
    }
}


const extension_root: string = join(__dirname, '..', '..', '..');

const r_syntax_file: string = join(extension_root, 'syntax', 'r.json');
console.log(r_syntax_file);
const rsyntax_raw = readFileSync(r_syntax_file) as unknown;
const rsyntax: syntaxFile = JSON.parse(rsyntax_raw as string) as syntaxFile;

const function_pattern: string = rsyntax.repository['function-declarations'].patterns[0].begin;

suite('Syntax Highlighting', () => {

    test('function-declarations - basic match', () => {
        const re = new RegExp(function_pattern);
        const line = 'x <- function(x) {';
        const match = re.exec(line);
        assert.ok(match);
        assert.strictEqual(match[3], 'function');
    });

    test('function-declarations - extra spacing', () => {
        const re = new RegExp(function_pattern);
        const line = 'x <- function  (x) {';
        const match = re.exec(line);
        assert.ok(match);
        assert.strictEqual(match[3], 'function');
    });

    test('function-declarations - false function', () => {
        const re = new RegExp(function_pattern);
        const line = 'x <- functions';
        const match = re.exec(line);
        assert.strictEqual(match, null);
    });

});
