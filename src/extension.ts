
'use strict';

// interfaces, functions, etc. provided by vscode
import * as vscode from 'vscode';

// functions etc. implemented in this extension
import * as preview from './preview';
import * as rGitignore from './rGitignore';
import * as rTerminal from './rTerminal';
import * as session from './session';
import * as util from './util';
import * as rstudioapi from './rstudioapi';
import * as rmarkdown from './rmarkdown';
import * as workspaceViewer from './workspaceViewer';
import * as apiImplementation from './apiImplementation';
import * as rHelp from './helpViewer';
import * as completions from './completions';
import * as httpgdViewer from './plotViewer';


// global objects used in other files
export let rWorkspace: workspaceViewer.WorkspaceDataProvider | undefined = undefined;
export let globalRHelp: rHelp.RHelp | undefined = undefined;
export let extensionContext: vscode.ExtensionContext;
export let globalHttpgdManager: httpgdViewer.HttpgdManager | undefined = undefined;


// Called (once) when the extension is activated
export async function activate(context: vscode.ExtensionContext): Promise<apiImplementation.RExtensionImplementation> {
    // create a new instance of RExtensionImplementation
    // is used to export an interface to the help panel
    // this export is used e.g. by vscode-r-debugger to show the help panel from within debug sessions
    const rExtension = new apiImplementation.RExtensionImplementation();
    
    // assign extension context to global variable
    extensionContext = context;

    // register commands specified in package.json
    const commands = {
        // create R terminal
        'r.createRTerm': rTerminal.createRTerm,

        // run code from editor in terminal 
        'r.nrow': () => rTerminal.runSelectionOrWord(['nrow']),
        'r.length': () => rTerminal.runSelectionOrWord(['length']),
        'r.head': () => rTerminal.runSelectionOrWord(['head']),
        'r.thead': () => rTerminal.runSelectionOrWord(['t', 'head']),
        'r.names': () => rTerminal.runSelectionOrWord(['names']),
        'r.runSource': () => { void rTerminal.runSource(false); },
        'r.runSelection': rTerminal.runSelection,
        'r.runFromLineToEnd': rTerminal.runFromLineToEnd,
        'r.runFromBeginningToLine': rTerminal.runFromBeginningToLine,
        'r.runSelectionRetainCursor': rTerminal.runSelectionRetainCursor,
        'r.runCommandWithSelectionOrWord': rTerminal.runCommandWithSelectionOrWord,
        'r.runCommandWithEditorPath': rTerminal.runCommandWithEditorPath,
        'r.runCommand': rTerminal.runCommand,
        'r.runSourcewithEcho': () => { void rTerminal.runSource(true); },

        // rmd related
        'r.knitRmd': () => { void rTerminal.knitRmd(false, undefined); },
        'r.knitRmdToPdf': () => { void rTerminal.knitRmd(false, 'pdf_document'); },
        'r.knitRmdToHtml': () => { void rTerminal.knitRmd(false, 'html_document'); },
        'r.knitRmdToAll': () => { void rTerminal.knitRmd(false, 'all'); },
        'r.selectCurrentChunk': rmarkdown.selectCurrentChunk,
        'r.runCurrentChunk': rmarkdown.runCurrentChunk,
        'r.runPreviousChunk': rmarkdown.runPreviousChunk,
        'r.runNextChunk': rmarkdown.runNextChunk,
        'r.runAboveChunks': rmarkdown.runAboveChunks,
        'r.runCurrentAndBelowChunks': rmarkdown.runCurrentAndBelowChunks,
        'r.runBelowChunks': rmarkdown.runBelowChunks,
        'r.runAllChunks': rmarkdown.runAllChunks,
        'r.goToPreviousChunk': rmarkdown.goToPreviousChunk,
        'r.goToNextChunk': rmarkdown.goToNextChunk,
        'r.runChunks': rTerminal.runChunksInTerm,

        // editor independent commands
        'r.createGitignore': rGitignore.createGitignore,
        'r.loadAll': () => rTerminal.runTextInTerm('devtools::load_all()'),
        'r.test': () => rTerminal.runTextInTerm('devtools::test()'),
        'r.install': () => rTerminal.runTextInTerm('devtools::install()'),
        'r.build': () => rTerminal.runTextInTerm('devtools::build()'),
        'r.document': () => rTerminal.runTextInTerm('devtools::document()'),

        // interaction with R sessions
        'r.previewDataframe': preview.previewDataframe,
        'r.previewEnvironment': preview.previewEnvironment,
        'r.attachActive': session.attachActive,
        'r.showPlotHistory': session.showPlotHistory,
        'r.launchAddinPicker': rstudioapi.launchAddinPicker,

        // workspace viewer
        'r.workspaceViewer.refreshEntry': () => rWorkspace?.refresh(),
        'r.workspaceViewer.view': (node: workspaceViewer.WorkspaceItem) => rTerminal.runTextInTerm(`View(${node.label})`),
        'r.workspaceViewer.remove': (node: workspaceViewer.WorkspaceItem) => rTerminal.runTextInTerm(`rm(${node.label})`),
        'r.workspaceViewer.clear': workspaceViewer.clearWorkspace,
        'r.workspaceViewer.load': workspaceViewer.loadWorkspace,
        'r.workspaceViewer.save': workspaceViewer.saveWorkspace,

        // browser controls
        'r.browser.refresh': session.refreshBrowser,
        'r.browser.openExternal': session.openExternalBrowser

        // (help related commands are registered in rHelp.initializeHelp)
    };
    for(const key in commands){
        context.subscriptions.push(vscode.commands.registerCommand(key, commands[key]));
    }


    // keep track of terminals
    context.subscriptions.push(vscode.window.onDidCloseTerminal(rTerminal.deleteTerminal));


    // register on-enter rule for roxygen comments
    const wordPattern = /(-?\d*\.\d\w*)|([^`~!@$^&*()=+[{\]}\\|;:'",<>/\s]+)/g;
    vscode.languages.setLanguageConfiguration('r', {
		onEnterRules: [
			{
				// Automatically continue roxygen comments: #'
				action: { indentAction: vscode.IndentAction.None, appendText: '#\' ' },
				beforeText: /^#'.*/,
			},
		],
		wordPattern,
	});

    // initialize httpgd viewer
    globalHttpgdManager = httpgdViewer.initializeHttpgd();

    // initialize the package/help related functions
    globalRHelp = await rHelp.initializeHelp(context, rExtension);


    // register codelens and complmetion providers for r markdown
    vscode.languages.registerCodeLensProvider('rmd', new rmarkdown.RMarkdownCodeLensProvider());
    vscode.languages.registerCompletionItemProvider('rmd', new rmarkdown.RMarkdownCompletionItemProvider(), ' ', ',');


    // register (session) hover and completion providers
    vscode.languages.registerHoverProvider('r', new completions.HoverProvider());
    vscode.languages.registerHoverProvider('r', new completions.HelpLinkHoverProvider());
    vscode.languages.registerCompletionItemProvider('r', new completions.StaticCompletionItemProvider(), '@');


    // register task provider
    const type = 'R';
    vscode.tasks.registerTaskProvider(type, {
        provideTasks() {
            return [
                new vscode.Task({type: type}, vscode.TaskScope.Workspace, 'Check', 'R',
                    new vscode.ShellExecution('Rscript -e "devtools::check()"')),
                new vscode.Task({type: type}, vscode.TaskScope.Workspace, 'Document', 'R',
                    new vscode.ShellExecution('Rscript -e "devtools::document()"')),
                new vscode.Task({type: type}, vscode.TaskScope.Workspace, 'Install', 'R',
                    new vscode.ShellExecution('Rscript -e "devtools::install()"')),
                new vscode.Task({type: type}, vscode.TaskScope.Workspace, 'Test', 'R',
                    new vscode.ShellExecution('Rscript -e "devtools::test()"')),
            ];
        },
        resolveTask(task: vscode.Task) {
            return task;
        }
    });


    // deploy session watcher (if configured by user)
    const enableSessionWatcher = util.config().get<boolean>('sessionWatcher', false);
    if (enableSessionWatcher) {
        console.info('Initialize session watcher');
        session.deploySessionWatcher(context.extensionPath);

        // create status bar item that contains info about the session watcher
        console.info('Create sessionStatusBarItem');
        const sessionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
        sessionStatusBarItem.command = 'r.attachActive';
        sessionStatusBarItem.text = 'R: (not attached)';
        sessionStatusBarItem.tooltip = 'Attach Active Terminal';
        sessionStatusBarItem.show();
        context.subscriptions.push(sessionStatusBarItem);
        session.startRequestWatcher(sessionStatusBarItem);

        // track active text editor
        rstudioapi.trackLastActiveTextEditor(vscode.window.activeTextEditor);
        vscode.window.onDidChangeActiveTextEditor(rstudioapi.trackLastActiveTextEditor);

        // register the R Workspace tree view
        // creates a custom context value for the workspace view
        // only shows view when session watcher is enabled
        rWorkspace = new workspaceViewer.WorkspaceDataProvider();
        vscode.window.registerTreeDataProvider(
            'workspaceViewer',
            rWorkspace
        );
        void vscode.commands.executeCommand('setContext', 'r.WorkspaceViewer:show', enableSessionWatcher);

        // if session watcher is active, register dyamic completion provider
        const liveTriggerCharacters = ['', '[', '(', ',', '$', '@', '"', '\'' ];
        vscode.languages.registerCompletionItemProvider('r', new completions.LiveCompletionItemProvider(), ...liveTriggerCharacters);
    }

    return rExtension;
}

