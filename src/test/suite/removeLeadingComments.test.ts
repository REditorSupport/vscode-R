

import * as assert from 'assert';
import { removeLeadingComments } from '../../selection';

// Defines a Mocha test suite to group tests of similar kind together
suite('removeLeadingComments Tests', () => {


    test('Check that nothing changes if no comments', () => {
        const input = `\
        function (x) {
            y = x
            y
        }
        `;
        const expectedOutput = `\
        function (x) {
            y = x
            y
        }
        `;
        const result = removeLeadingComments(input);
        assert.strictEqual(result, expectedOutput);
    });
    
    test('Check that basic comments are removed', () => {
        const input = `\
        # a leading comment
        function (x) {
            y = x
            y
        }
        `;
        const expectedOutput = `\
        function (x) {
            y = x
            y
        }
        `;
        const result = removeLeadingComments(input);
        assert.strictEqual(result, expectedOutput);
    });
        
    test('Check that inner comments are not removed', () => {
        const input = `\
        
        # a leading comment
        # Another leading comment
        
        function (x) {
            y = x
        # inner comment
            y
        }
        `;
        const expectedOutput = `\
        function (x) {
            y = x
        # inner comment
            y
        }
        `;
        const result = removeLeadingComments(input);
        assert.strictEqual(result, expectedOutput);
    });
});
