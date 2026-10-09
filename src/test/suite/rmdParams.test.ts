import * as assert from 'assert';
import * as vscode from 'vscode';
import * as rTerminal from '../../rTerminal';

suite('Rmd Params Test Suite', () => {
    test('getRmdParamsCommand returns undefined for non-rmd documents', () => {
        const mockDoc = {
            languageId: 'r',
            getText: () => '---\nparams:\n  a: 1\n---',
            uri: vscode.Uri.file('/test_non_rmd.R'),
            version: 1
        } as vscode.TextDocument;
        
        const cmd = rTerminal.getRmdParamsCommand(mockDoc);
        assert.strictEqual(cmd, undefined);
    });

    test('getRmdParamsCommand returns undefined if no YAML header', () => {
        const mockDoc = {
            languageId: 'rmd',
            getText: () => 'title: Test\nparams:\n  a: 1',
            uri: vscode.Uri.file('/test_no_header.Rmd'),
            version: 1
        } as vscode.TextDocument;
        
        const cmd = rTerminal.getRmdParamsCommand(mockDoc);
        assert.strictEqual(cmd, undefined);
    });

    test('getRmdParamsCommand returns undefined if no params in YAML', () => {
        const mockDoc = {
            languageId: 'rmd',
            getText: () => '---\ntitle: Test\n---',
            uri: vscode.Uri.file('/test_no_params.Rmd'),
            version: 1
        } as vscode.TextDocument;
        
        const cmd = rTerminal.getRmdParamsCommand(mockDoc);
        assert.strictEqual(cmd, undefined);
    });

    test('getRmdParamsCommand parses valid params', () => {
        const mockDoc = {
            languageId: 'rmd',
            getText: () => '---\nparams:\n  a: 1\n  b: "test"\n---',
            uri: vscode.Uri.file('/test_valid_params.Rmd'),
            version: 1
        } as vscode.TextDocument;
        
        const cmd = rTerminal.getRmdParamsCommand(mockDoc);
        assert.strictEqual(cmd, 'params <- list(a = 1, b = "test")');
    });

    test('getRmdParamsCommand handles custom !r type', () => {
        const mockDoc = {
            languageId: 'rmd',
            getText: () => '---\nparams:\n  a: !r 1+1\n---',
            uri: vscode.Uri.file('/test_custom_type.Rmd'),
            version: 1
        } as vscode.TextDocument;
        
        const cmd = rTerminal.getRmdParamsCommand(mockDoc);
        assert.strictEqual(cmd, 'params <- list(a = 1+1)');
    });

    test('getRmdParamsCommand preserves YAML merges, scalar types, and tagged expressions', () => {
        const mockDoc = {
            languageId: 'rmd',
            getText: () => `---
defaults: &defaults
  count: 2
  expression: !r seq_len(3)
params:
  <<: *defaults
  enabled: false
  label: yes
  values: [1, null, true]
---`,
            uri: vscode.Uri.file('/test_merged_params.Rmd'),
            version: 1,
        } as vscode.TextDocument;
        assert.strictEqual(rTerminal.getRmdParamsCommand(mockDoc),
            'params <- list(count = 2, expression = seq_len(3), enabled = FALSE, label = "yes", values = c(1, NULL, TRUE))');
    });

    test('getRmdParamsCommand respects cache invalidation by version', () => {
        const mockDoc = {
            languageId: 'rmd',
            getText: () => '---\nparams:\n  a: 1\n---',
            uri: vscode.Uri.file('/test_cache_invalidation.Rmd'),
            version: 1
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
            version: 2
        } as vscode.TextDocument;
        
        cmd = rTerminal.getRmdParamsCommand(updatedDoc);
        assert.strictEqual(cmd, 'params <- list(a = 2)');
    });
});
