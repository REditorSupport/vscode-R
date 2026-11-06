import * as assert from 'assert';
import * as vscode from 'vscode';
import * as rTerminal from '../../rTerminal';

suite('Rmd Params Test Suite', () => {
    test('getRmdParamsCommand returns undefined for non-rmd documents', () => {
        const mockDoc = {
            languageId: 'r',
            getText: () => '---\nparams:\n  a: 1\n---',
            uri: vscode.Uri.file('/test_non_rmd.R'),
            version: 1,
        } as vscode.TextDocument;

        const cmd = rTerminal.getRmdParamsCommand(mockDoc);
        assert.strictEqual(cmd, undefined);
    });

    test('getRmdParamsCommand returns undefined if no YAML header', () => {
        const mockDoc = {
            languageId: 'rmd',
            getText: () => 'title: Test\nparams:\n  a: 1',
            uri: vscode.Uri.file('/test_no_header.Rmd'),
            version: 1,
        } as vscode.TextDocument;

        const cmd = rTerminal.getRmdParamsCommand(mockDoc);
        assert.strictEqual(cmd, undefined);
    });

    test('getRmdParamsCommand returns undefined if no params in YAML', () => {
        const mockDoc = {
            languageId: 'rmd',
            getText: () => '---\ntitle: Test\n---',
            uri: vscode.Uri.file('/test_no_params.Rmd'),
            version: 1,
        } as vscode.TextDocument;

        const cmd = rTerminal.getRmdParamsCommand(mockDoc);
        assert.strictEqual(cmd, undefined);
    });

    test('getRmdParamsCommand parses valid params', () => {
        const mockDoc = {
            languageId: 'rmd',
            getText: () => '---\nparams:\n  a: 1\n  b: "test"\n---',
            uri: vscode.Uri.file('/test_valid_params.Rmd'),
            version: 1,
        } as vscode.TextDocument;

        const cmd = rTerminal.getRmdParamsCommand(mockDoc);
        assert.strictEqual(cmd, 'params <- list(a = 1, b = "test")');
    });

    test('getRmdParamsCommand handles custom !r type', () => {
        const mockDoc = {
            languageId: 'rmd',
            getText: () => '---\nparams:\n  a: !r 1+1\n---',
            uri: vscode.Uri.file('/test_custom_type.Rmd'),
            version: 1,
        } as vscode.TextDocument;

        const cmd = rTerminal.getRmdParamsCommand(mockDoc);
        assert.strictEqual(cmd, 'params <- list(a = 1+1)');
    });

    test('getRmdParamsCommand preserves merged parameter defaults and nested !r values', () => {
        const mockDoc = {
            languageId: 'rmd',
            getText: () => `---
defaults: &defaults
  count: 2
  label: default
params:
  <<: *defaults
  label: overridden
  expression:
    value: !r |
      sum(c(1, 2))
  values: [true, null, !r 1+1]
---`,
            uri: vscode.Uri.file('/test_merged_params.Rmd'),
            version: 1,
        } as vscode.TextDocument;

        assert.strictEqual(
            rTerminal.getRmdParamsCommand(mockDoc),
            'params <- list(count = 2, label = "overridden", expression = sum(c(1, 2))\n, values = c(TRUE, NULL, 1+1))',
        );
    });

    test('getRmdParamsCommand keeps YAML 1.2 scalars with legacy metadata tags', () => {
        const mockDoc = {
            languageId: 'rmd',
            getText: () => `---
date: !!timestamp 2026-11-07
params:
  enabled: true
  label: yes
  mode: on
  count: 012
  binary: 0b101
  hex: -0xF
  nothing: null
---`,
            uri: vscode.Uri.file('/test_scalar_params.Rmd'),
            version: 1,
        } as vscode.TextDocument;

        assert.strictEqual(
            rTerminal.getRmdParamsCommand(mockDoc),
            'params <- list(enabled = TRUE, label = "yes", mode = "on", count = 12, binary = 5, hex = -15, nothing = NULL)',
        );
    });

    test('getRmdParamsCommand preserves set parameters as named null values', () => {
        const mockDoc = {
            languageId: 'rmd',
            getText: () => '---\nparams:\n  choices: !!set {one: null, two: null}\n---',
            uri: vscode.Uri.file('/test_set_params.Rmd'),
            version: 1,
        } as vscode.TextDocument;

        assert.strictEqual(
            rTerminal.getRmdParamsCommand(mockDoc),
            'params <- list(choices = list(one = NULL, two = NULL))',
        );
    });

    test('getRmdParamsCommand rejects malformed YAML and non-scalar !r tags', () => {
        for (const [index, value] of [
            '[1,',
            '!unknown value',
            '!r [1, 2]',
            '!r {a: 1}',
        ].entries()) {
            const mockDoc = {
                languageId: 'rmd',
                getText: () => `---\nparams:\n  a: ${value}\n---`,
                uri: vscode.Uri.file(`/test_invalid_params_${index}.Rmd`),
                version: 1,
            } as vscode.TextDocument;

            assert.strictEqual(rTerminal.getRmdParamsCommand(mockDoc), undefined);
        }
    });

    test('getRmdParamsCommand respects cache invalidation by version', () => {
        const mockDoc = {
            languageId: 'rmd',
            getText: () => '---\nparams:\n  a: 1\n---',
            uri: vscode.Uri.file('/test_cache_invalidation.Rmd'),
            version: 1,
        } as vscode.TextDocument;

        let cmd = rTerminal.getRmdParamsCommand(mockDoc);
        assert.strictEqual(cmd, 'params <- list(a = 1)');

        // Same file, same version -> returns undefined (cached)
        cmd = rTerminal.getRmdParamsCommand(mockDoc);
        assert.strictEqual(cmd, undefined);

        // Same file, new version -> parses again
        const updatedDoc = {
            ...mockDoc,
            getText: () => '---\nparams:\n  a: 2\n---',
            version: 2,
        } as vscode.TextDocument;

        cmd = rTerminal.getRmdParamsCommand(updatedDoc);
        assert.strictEqual(cmd, 'params <- list(a = 2)');
    });
});
