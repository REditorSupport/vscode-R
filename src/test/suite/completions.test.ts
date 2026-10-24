import * as vscode from 'vscode';
import * as sinon from 'sinon';
import * as assert from 'assert';

import * as session from '../../session';
import { HoverProvider, LiveCompletionItemProvider } from '../../completions';

suite('Session hover and completion', () => {
    let sandbox: sinon.SinonSandbox;
    let sessionRequest: sinon.SinonStub;

    const content = 'rm(list = ls())\n# comment\nx <- list(a = 1)\nf()$\n';

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox
            .stub(session, 'workspaceData')
            .value({ search: [], loaded_namespaces: [], globalenv: {} });
        sandbox
            .stub(session, 'activeSession')
            .value({ workspaceData: { search: [], loaded_namespaces: [], globalenv: {} } });
        sandbox.stub(session, 'globalPipePath').value('/tmp/vscode-r-test.sock');
        sessionRequest = sandbox.stub(session, 'sessionRequest').resolves(undefined);
    });

    teardown(() => {
        sandbox.restore();
    });

    async function openDocument(): Promise<vscode.TextDocument> {
        return vscode.workspace.openTextDocument({ language: 'r', content });
    }

    test('hover on a word sends only that expression', async () => {
        const document = await openDocument();
        await new HoverProvider().provideHover(document, new vscode.Position(2, 0));

        sinon.assert.calledOnceWithExactly(
            sessionRequest,
            { method: 'hover', params: { expr: 'x' } },
            session.activeSession,
        );
    });

    test('hover on punctuation sends no request', async () => {
        const document = await openDocument();
        const hover = await new HoverProvider().provideHover(document, new vscode.Position(1, 0));

        assert.strictEqual(hover, null);
        sinon.assert.notCalled(sessionRequest);
    });

    test('completion after a call result sends no request', async () => {
        const document = await openDocument();
        const token = new vscode.CancellationTokenSource().token;
        const items = await new LiveCompletionItemProvider().provideCompletionItems(
            document,
            new vscode.Position(3, 4),
            token,
            { triggerKind: vscode.CompletionTriggerKind.TriggerCharacter, triggerCharacter: '$' },
        );

        assert.deepStrictEqual(items, []);
        sinon.assert.notCalled(sessionRequest);
    });
});

suite('Session pipeline completion', () => {
    let sandbox: sinon.SinonSandbox;
    let cancellation: vscode.CancellationTokenSource;
    let request: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        cancellation = new vscode.CancellationTokenSource();
        const object = (names: string[]) => ({
            class: ['data.frame'],
            type: 'list',
            length: names.length,
            str: 'data.frame',
            names,
        });
        const workspaceData: session.WorkspaceData = {
            search: [],
            loaded_namespaces: [],
            globalenv: {
                raw: object(['sample', 'umi1']),
                other: object(['other_column']),
                'raw data': object(['quoted_column']),
                数据: object(['unicode_column']),
            },
        };
        sandbox.stub(session, 'sessionForDocument').returns({ workspaceData } as session.Session);
        request = sandbox.stub(session, 'sessionRequest');
    });

    teardown(() => {
        cancellation.dispose();
        sandbox.restore();
    });

    const cases: [string, string[]][] = [
        ['raw %>% select(<cursor>)', ['sample', 'umi1']],
        ['(\n raw %>% select(<cursor>)\n)', ['sample', 'umi1']],
        ['(\n (\n raw\n |> select(<cursor>)\n )\n)', ['sample', 'umi1']],
        ['result <- (\n raw %<>% select(<cursor>)\n)', ['sample', 'umi1']],
        ['print(raw %T>% select(<cursor>))', ['sample', 'umi1']],
        ['raw %>% select(a, <cursor>)', ['sample', 'umi1']],
        ['raw %>% mutate(x = other |> select(<cursor>))', ['other_column']],
        ['raw %>% { . %>% select(<cursor>) }', ['sample', 'umi1']],
        ['raw %>% mutate(x = other %>% { . %>% select(<cursor>) })', ['other_column']],
        ['list(raw %>% select(a), other %>% select(<cursor>))', ['other_column']],
        ['raw %>% mutate(x = other %>% select(a), y = sum(<cursor>))', ['sample', 'umi1']],
        ['`raw data` %>% select(<cursor>)', ['quoted_column']],
        ['数据 |> select(<cursor>)', ['unicode_column']],
        ['raw %>% select(a); select(<cursor>)', []],
        ['list(raw %>% select(a), select(<cursor>))', []],
        ['raw %>% select(a) + select(<cursor>)', []],
        ['identity(raw) %>% select(<cursor>)', []],
        ['raw %>% mutate(x = identity(other) %>% select(<cursor>))', []],
        ['raw %>% mutate(note = "other %>% select(<cursor>)")', []],
        ['raw %>% mutate( # comment <cursor>\n)', []],
        ['select(<cursor>); raw %>% select(a)', []],
        [
            'f <- function(x) { other %>% select(a) }\n(raw\n |> select(<cursor>))',
            ['sample', 'umi1'],
        ],
    ];

    for (const [content, expected] of cases) {
        test(`completes ${JSON.stringify(content)}`, async () => {
            const offset = content.indexOf('<cursor>');
            const document = await vscode.workspace.openTextDocument({
                language: 'r',
                content: content.replace('<cursor>', ''),
            });
            const before = content.slice(0, offset).trimEnd();
            const trigger = before.endsWith(',') ? ',' : '(';
            const items = await new LiveCompletionItemProvider().provideCompletionItems(
                document,
                document.positionAt(offset),
                cancellation.token,
                {
                    triggerKind: vscode.CompletionTriggerKind.TriggerCharacter,
                    triggerCharacter: trigger,
                },
            );
            assert.deepStrictEqual(
                items.map((item) => item.label),
                expected,
            );
            assert.ok(items.every((item) => item.detail === '[session]'));
            sinon.assert.notCalled(request);
        });
    }

    for (const [code, expected] of [
        ['(\n raw\n |> select(<cursor>)\n)', ['sample', 'umi1']],
        ['select(<cursor>)', []],
    ] as [string, string[]][]) {
        test(`completes within the current R Markdown chunk: ${JSON.stringify(code)}`, async () => {
            const content =
                'Text with an unmatched " quote.\n\n```{r}\nother %>% select(a)\n```\n\n```{r}\n' +
                code +
                '\n```';
            const offset = content.indexOf('<cursor>');
            const document = await vscode.workspace.openTextDocument({
                language: 'rmd',
                content: content.replace('<cursor>', ''),
            });
            const items = await new LiveCompletionItemProvider().provideCompletionItems(
                document,
                document.positionAt(offset),
                cancellation.token,
                {
                    triggerKind: vscode.CompletionTriggerKind.TriggerCharacter,
                    triggerCharacter: '(',
                },
            );
            assert.deepStrictEqual(
                items.map((item) => item.label),
                expected,
            );
            sinon.assert.notCalled(request);
        });
    }

    test('VS Code completion requests include the pipeline columns', async () => {
        const content = '(\n raw\n |> select(\n)\n)';
        const document = await vscode.workspace.openTextDocument({ language: 'r', content });
        const provider = vscode.languages.registerCompletionItemProvider(
            { language: 'r', scheme: 'untitled' },
            new LiveCompletionItemProvider(),
            '(',
        );
        try {
            const result = await vscode.commands.executeCommand<vscode.CompletionList>(
                'vscode.executeCompletionItemProvider',
                document.uri,
                document.positionAt(content.indexOf('select(') + 'select('.length),
                '(',
            );
            assert.ok(result);
            const columns = result.items.filter((item) => item.detail === '[session]');
            assert.deepStrictEqual(
                columns.map((item) => item.label),
                ['sample', 'umi1'],
            );
            sinon.assert.notCalled(request);
        } finally {
            provider.dispose();
        }
    });

    test('cancellation suppresses pipeline completion', async () => {
        cancellation.cancel();
        const document = await vscode.workspace.openTextDocument({
            language: 'r',
            content: 'raw |> select(',
        });
        const items = await new LiveCompletionItemProvider().provideCompletionItems(
            document,
            document.positionAt(document.getText().length),
            cancellation.token,
            { triggerKind: vscode.CompletionTriggerKind.TriggerCharacter, triggerCharacter: '(' },
        );
        assert.deepStrictEqual(items, []);
        sinon.assert.notCalled(request);
    });

    test('cancellation can interrupt a large document completion', async () => {
        const content = 'value <- mean(1:10)\n'.repeat(10000) + 'raw |> select(';
        const document = await vscode.workspace.openTextDocument({ language: 'r', content });
        const pending = new LiveCompletionItemProvider().provideCompletionItems(
            document,
            document.positionAt(content.length),
            cancellation.token,
            { triggerKind: vscode.CompletionTriggerKind.TriggerCharacter, triggerCharacter: '(' },
        );
        setImmediate(() => cancellation.cancel());
        assert.deepStrictEqual(await pending, []);
        assert.ok(cancellation.token.isCancellationRequested);
        sinon.assert.notCalled(request);
    });

    test('a document edit during scanning suppresses stale pipeline columns', async () => {
        const content = 'value <- mean(1:10)\n'.repeat(10000) + 'raw |> select(';
        const realDocument = await vscode.workspace.openTextDocument({ language: 'r', content });
        let version = 1;
        const document = {
            languageId: 'r',
            uri: realDocument.uri,
            get version() {
                return version;
            },
            getText: (range?: vscode.Range) => realDocument.getText(range),
        } as vscode.TextDocument;
        const pending = new LiveCompletionItemProvider().provideCompletionItems(
            document,
            realDocument.positionAt(content.length),
            cancellation.token,
            { triggerKind: vscode.CompletionTriggerKind.TriggerCharacter, triggerCharacter: '(' },
        );
        setImmediate(() => {
            version++;
        });
        assert.deepStrictEqual(await pending, []);
        assert.strictEqual(version, 2);
        sinon.assert.notCalled(request);
    });
});
