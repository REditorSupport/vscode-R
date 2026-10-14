import * as assert from 'assert';
import * as vscode from 'vscode';
import { getChunks } from '../../rmarkdown/chunks';

suite('R code chunk boundaries', () => {
    async function chunkCode(text: string, language = 'r') {
        const document = await vscode.workspace.openTextDocument({ language, content: text });
        return getChunks(document).map(chunk => document.getText(chunk.codeRange));
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
});
