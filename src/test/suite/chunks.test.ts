import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as executionTarget from '../../interactive/executionTarget';
import { getChunks, getCurrentChunk } from '../../rmarkdown/chunks';
import { runSourceWithEcho } from '../../rmarkdown';

suite('R code chunk boundaries', () => {
    async function chunkCode(text: string, language = 'r') {
        const document = await vscode.workspace.openTextDocument({ language, content: text });
        return getChunks(document).map((chunk) => document.getText(chunk.codeRange));
    }

    test('the run shortcut has one binding per editor language', () => {
        const manifest = vscode.extensions.getExtension('REditorSupport.r')!.packageJSON as {
            contributes: {
                keybindings: {
                    key: string;
                    mac?: string;
                    command: string;
                    when: string;
                    args?: unknown;
                }[];
            };
        };
        const normalize = (key: string) => key.toLowerCase().split('+').sort().join('+');
        for (const platform of ['key', 'mac'] as const) {
            const shortcut = normalize(platform === 'mac' ? 'cmd+shift+enter' : 'ctrl+shift+enter');
            const bindings = manifest.contributes.keybindings.filter(
                (binding) => normalize(binding[platform] ?? binding.key) === shortcut,
            );
            assert.strictEqual(bindings.length, 2);
            assert.deepStrictEqual(Object.fromEntries(bindings.map((b) => [b.command, b.when])), {
                'r.runCurrentChunk': "editorTextFocus && editorLangId == 'rmd'",
                'r.runSourcewithEcho': "editorTextFocus && editorLangId == 'r'",
            });
            assert.deepStrictEqual(
                bindings.find((b) => b.command === 'r.runSourcewithEcho')?.args,
                { runChunkAtCursor: true },
            );
        }
    });

    test('the R shortcut submits only the chunk at the cursor and sources the file outside chunks', async () => {
        const text = 'outside <- 1\n# %%\ninside <- 2\n# section ----\noutside <- 3\n# %%';
        const document = await vscode.workspace.openTextDocument({ language: 'r', content: text });
        const sandbox = sinon.createSandbox();
        try {
            let line = 0;
            sandbox.stub(vscode.window, 'activeTextEditor').get(() => ({
                document,
                selection: new vscode.Selection(0, 0, line, 0),
            }));
            const submit = sandbox
                .stub(executionTarget, 'tryInteractiveExecution')
                .resolves('executed');
            for (const [cursor, expected] of [
                [1, 'inside <- 2'],
                [2, 'inside <- 2'],
                [0, text],
                [4, text],
            ] as const) {
                line = cursor;
                await runSourceWithEcho({ runChunkAtCursor: true });
                assert.strictEqual(submit.callCount, 1);
                assert.strictEqual(submit.firstCall.args[0], expected);
                submit.resetHistory();
            }
            line = 5;
            await runSourceWithEcho({ runChunkAtCursor: true });
            sinon.assert.notCalled(submit);
            line = 2;
            await runSourceWithEcho();
            assert.strictEqual(submit.firstCall.args[0], text);
        } finally {
            sandbox.restore();
        }
    });

    test('includes the final code line without a trailing newline', async () => {
        assert.deepStrictEqual(await chunkCode('# %%\nx <- 1'), ['x <- 1']);
        assert.deepStrictEqual(await chunkCode('# %%\nx <- 1\ny <- 2'), ['x <- 1\ny <- 2']);
    });

    test('handles a final chunk marker and adjacent empty chunks', async () => {
        assert.deepStrictEqual(await chunkCode('# %%\nx <- 1\n# %%'), ['x <- 1', '']);
        assert.deepStrictEqual(await chunkCode('# %%\n# %%\ny <- 2'), ['', 'y <- 2']);
        assert.deepStrictEqual(await chunkCode('# %%'), ['']);
    });

    test('empty fenced R Markdown chunks never include their delimiters', async () => {
        assert.deepStrictEqual(await chunkCode('```{r}\n```', 'rmd'), ['']);
        assert.deepStrictEqual(await chunkCode('```{r}\nx <- 1\n```', 'rmd'), ['x <- 1']);
    });

    test('keeps a longer outer fence open through a shorter inner example', async () => {
        const text = '````{verbatim}\n\n```{r}\nfoo <- 1\n```\n\n````';
        const document = await vscode.workspace.openTextDocument({
            language: 'rmd',
            content: text,
        });
        const chunks = getChunks(document);
        assert.strictEqual(chunks.length, 1);
        assert.strictEqual(chunks[0].language, 'verbatim');
        assert.strictEqual(chunks[0].startLine, 0);
        assert.strictEqual(chunks[0].endLine, 6);
        assert.deepStrictEqual(document.getText(chunks[0].codeRange).split('\n'), [
            '',
            '```{r}',
            'foo <- 1',
            '```',
            '',
        ]);
    });

    test('ends a chunk on a longer fence and resumes with the next real chunk', async () => {
        assert.deepStrictEqual(await chunkCode('```{r}\nx <- 1\n````', 'rmd'), ['x <- 1']);
        const nestedThenReal =
            '````{verbatim}\n\n```{r}\nfoo <- 1\n```\n\n````\n```{r}\nx <- 1\n```';
        assert.deepStrictEqual(await chunkCode(nestedThenReal, 'rmd'), [
            '\n```{r}\nfoo <- 1\n```\n',
            'x <- 1',
        ]);
    });

    test('ignores info strings, bare fences, and unclosed R Markdown chunks', async () => {
        assert.deepStrictEqual(await chunkCode('```{r}\nx <- 1\n``` label\n```', 'rmd'), [
            'x <- 1\n``` label',
        ]);
        assert.deepStrictEqual(await chunkCode('```\ncode\n```', 'rmd'), []);
        assert.deepStrictEqual(await chunkCode('```{r}\nx <- 1', 'rmd'), []);
    });

    test('section headers end an R chunk without dropping its preceding line', async () => {
        assert.deepStrictEqual(await chunkCode('# %%\nx <- 1\n# section ----'), ['x <- 1']);
    });

    test('reuses chunk scans until the document version or language changes', () => {
        let scans = 0;
        const document = {
            version: 1,
            languageId: 'r',
            getText: () => {
                scans++;
                return '# %%\nx <- 1';
            },
        } as vscode.TextDocument;
        const first = getChunks(document);
        assert.strictEqual(getChunks(document), first);
        assert.strictEqual(scans, 1);

        Object.assign(document, { version: 2 });
        assert.notStrictEqual(getChunks(document), first);
        assert.strictEqual(scans, 2);

        Object.assign(document, { languageId: 'rmd' });
        assert.deepStrictEqual(getChunks(document), []);
        assert.strictEqual(scans, 3);
    });

    test('current chunk lookup does not depend on an active editor', async () => {
        const document = await vscode.workspace.openTextDocument({
            language: 'r',
            content: '# %%\nx <- 1\n# %%\ny <- 2',
        });
        const chunks = getChunks(document);
        assert.strictEqual(getCurrentChunk(chunks, 0), chunks[0]);
        assert.strictEqual(getCurrentChunk(chunks, 3), chunks[1]);
    });
});
