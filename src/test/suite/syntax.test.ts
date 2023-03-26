'use strict';

import { readFileSync } from 'fs';
import { join } from 'path';
import * as assert from 'assert';

interface syntaxFile {
    'repository': {
        'function-declarations': {
            'patterns': [
                {
                    'match':string
                }
            ]
        }
    }
}


/**
 * Converts a POSIX regular expression string into a format
 * that JavaScript can use. This is because vscode parses
 * syntax files using POSIX but JavaScript can't support it.
 * @param {string} s - A string to be used as a regular expression
 */
const regex_from_posix = function (s: string): string {
    const mappings = [
        ['[:alnum:]', 'a-zA-Z0-9'],
        ['[:alpha:]', 'a-zA-Z']
    ];
    let s2 = s;
    mappings.forEach((el) => {
        s2 = s2.replace(el[0], el[1]);
    });
    return s2;
};


const extension_root: string = join(__dirname, '..', '..', '..');

const r_syntax_file: string = join(extension_root, 'syntax', 'r.json');
console.log(r_syntax_file);
const rsyntax_raw = readFileSync(r_syntax_file) as unknown;
const rsyntax: syntaxFile = JSON.parse(rsyntax_raw as string) as syntaxFile;

const function_pattern: string = rsyntax.repository['function-declarations'].patterns[0].match;
const function_pattern_fixed: string = regex_from_posix(function_pattern);


suite('Syntax Highlighting', () => {

    test('function-declarations - basic match', () => {
        const re = new RegExp(function_pattern_fixed);
        const line = 'x <- function(x) {';
        const match = re.exec(line);
        assert.ok(match);
        assert.strictEqual(match[3], 'function');
    });

    test('function-declarations - extra spacing', () => {
        const re = new RegExp(function_pattern_fixed);
        const line = 'x <- function  (x) {';
        const match = re.exec(line);
        assert.ok(match);
        assert.strictEqual(match[3], 'function');
    });

    test('function-declarations - false function', () => {
        const re = new RegExp(function_pattern_fixed);
        const line = 'x <- functions';
        const match = re.exec(line);
        assert.strictEqual(match, null);
    });

});
