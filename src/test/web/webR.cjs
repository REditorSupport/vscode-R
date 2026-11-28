const vscode = require('vscode');

function assert(condition, message) {
    if (!condition) {throw new Error(message);}
}

async function until(check, message) {
    const start = Date.now();
    while (Date.now() - start < 180000) {
        const value = await check();
        if (value) {return value;}
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(message);
}

// No local paths or platform-specific process APIs are available in a web
// extension host. The provider also exercises read/write to a virtual repository.
function testFiles() {
    const encoder = new TextEncoder();
    const files = new Map([
        ['/call.R', encoder.encode('result <- double_it(12)\n')],
        ['/helper.R', encoder.encode('helper <- function(x) x + 2\n')],
        ['/data.csv', encoder.encode('value\n3\n4\n')],
    ]);
    const changed = new vscode.EventEmitter();
    const provider = vscode.workspace.registerFileSystemProvider('r-webr-test', {
        onDidChangeFile: changed.event,
        watch: () => new vscode.Disposable(() => {}),
        stat: uri => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: files.get(uri.path)?.length ?? 0 }),
        readDirectory: () => [],
        createDirectory() {},
        delete(uri) { files.delete(uri.path); },
        rename() { throw vscode.FileSystemError.NoPermissions(); },
        readFile(uri) {
            const contents = files.get(uri.path);
            if (!contents) {throw vscode.FileSystemError.FileNotFound(uri);}
            return contents;
        },
        writeFile(uri, bytes) {
            files.set(uri.path, bytes);
            changed.fire([{type: vscode.FileChangeType.Changed, uri}]);
        },
    }, { isCaseSensitive: true });
    return {
        uri: name => vscode.Uri.from({scheme:'r-webr-test',path:'/'+name}),
        dispose() { provider.dispose(); changed.dispose(); },
    };
}

async function editor(text, language = 'r') {
    const document = await vscode.workspace.openTextDocument({language, content: text});
    return vscode.window.showTextDocument(document);
}

const command = (id, ...args) => vscode.commands.executeCommand(id, ...args);
const items = cell => cell.outputs.flatMap(out => out.items);
const stdout = cell => items(cell).filter(i => i.mime.endsWith('.stdout')).map(i => new TextDecoder().decode(i.data)).join('');

exports.run = async () => {
    const files = testFiles();
    try {
        const first = (await editor('double_it <- function(x) x * 2\n')).document;
        const other = await vscode.workspace.openTextDocument(files.uri('call.R'));
        await vscode.window.showTextDocument(other);
        await until(async () => {
            const defs = await command('vscode.executeDefinitionProvider', other.uri, new vscode.Position(0,14));
            return defs?.some(location => (location.uri ?? location.targetUri).toString() === first.uri.toString()
                && (location.range ?? location.targetSelectionRange).start.line === 0);
        }, 'Definition did not resolve across the virtual and unsaved documents.');

        await vscode.window.showTextDocument(first);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(first.uri, new vscode.Range(0,0,0,9),'triple_it');
        assert(await vscode.workspace.applyEdit(edit), 'Could not edit R document.');
        await until(async () => {
            const symbols = await command('vscode.executeDocumentSymbolProvider', first.uri);
            return symbols?.some(symbol => symbol.name === 'triple_it') && !symbols.some(symbol=>symbol.name==='double_it');
        }, 'Outline did not reflect the edit.');
        await command('r.runSource');
        const notebook = vscode.workspace.notebookDocuments.find(doc => doc.notebookType === 'r-interactive');
        assert(notebook?.cellCount === 1,'Run Source did not submit a cell.');

        const second = await editor('triple_it(21)\nplot(1:3)\n');
        second.selection = new vscode.Selection(new vscode.Position(0,0),second.document.positionAt(second.document.getText().length));
        await command('r.runSelectionRetainCursor');
        assert(notebook.cellCount === 2 && stdout(notebook.cellAt(1)).includes('42'), 'Run Selection did not reuse the R session.');
        assert(items(notebook.cellAt(1)).some(item => item.mime === 'image/png' && item.data[0] === 137 && item.data[1] === 80), 'Missing PNG output.');

        await command('r.webR.importFiles', [files.uri('helper.R'), files.uri('data.csv')]);
        await editor('```{r}\nsource("helper.R")\nanswer <- helper(sum(read.csv("data.csv")$value))\nwriteLines(as.character(answer), "out.txt")\nanswer\n```\n','rmd');
        await command('r.runCurrentChunk');
        assert(stdout(notebook.cellAt(2)).includes('9'), 'Imports or Run Current Chunk failed.');
        await command('r.webR.exportFile','out.txt',files.uri('result.txt'));
        assert(new TextDecoder().decode(await vscode.workspace.fs.readFile(files.uri('result.txt'))).trim()==='9','Incorrect exported result.');

        if (globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined') {
            const calculating = command('r.runCommand','cat("running\\n"); repeat { Sys.sleep(0.05) }');
            try {
                await until(() => notebook.cellCount >= 4 && stdout(notebook.cellAt(3)).includes('running'), 'The long calculation did not start.');
                const outline = await command('vscode.executeDocumentSymbolProvider', first.uri);
                assert(outline?.some(symbol => symbol.name === 'triple_it'), 'Language features unavailable while running R.');
            } finally {
                await command('r.interactive.interrupt');
            }
            await calculating;
            await command('r.runCommand','answer');
            assert(stdout(notebook.cellAt(4)).includes('9'), 'Interrupt lost the R environment.');
        }
        const savedUri = files.uri('transcript.rnb');
        const snapshot = new TextEncoder().encode(JSON.stringify({version:1,metadata:{},cells:[]}));
        await vscode.workspace.fs.writeFile(savedUri,snapshot);
        const saved = await vscode.workspace.openNotebookDocument(savedUri);
        await vscode.window.showNotebookDocument(saved);
        await command('r.runCommand','held_value <- 17; held_value');
        assert(stdout(saved.cellAt(0)).includes('17'), 'Saved notebook computation failed.');
        assert(await saved.save(),'Saving the .rnb transcript failed.');
        await command('workbench.action.closeActiveEditor');
        await until(() => !vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
            tab.input instanceof vscode.TabInputNotebook && tab.input.uri.toString() === savedUri.toString())), 'The saved notebook tab did not close.');
        const reopened = await vscode.workspace.openNotebookDocument(savedUri);
        await vscode.window.showNotebookDocument(reopened);
        assert(stdout(reopened.cellAt(0)).includes('17'), 'Saved notebook lost its transcript.');
        await command('r.runCommand','exists("held_value", inherits = FALSE)');
        assert(stdout(reopened.cellAt(1)).includes('FALSE'), 'Reopening retained stale R state.');
        console.log('Verified webR language features, R Interactive execution, files, and transcript reopening.');
    } finally {
        await command('r.interactive.stopAll');
        files.dispose();
    }
};
