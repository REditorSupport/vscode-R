import * as assert from 'assert';
import * as vscode from 'vscode';
import { getChunks, getCurrentChunk } from '../../rmarkdown/chunks';

suite('R code chunk boundaries', () => {
    async function chunkCode(text: string, language = 'r') {
        const document = await vscode.workspace.openTextDocument({ language, content: text });
        return getChunks(document).map((chunk) => document.getText(chunk.codeRange));
    }

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
