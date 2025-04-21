
'use strict';

// interfaces, functions, etc. provided by vscode
import * as vscode from 'vscode';
import * as os from 'os';
import path = require('path');

// functions etc. implemented in this extension
import * as preview from './preview';
import * as rGitignore from './rGitignore';
import * as lintrConfig from './lintrConfig';
import * as cppProperties from './cppProperties';
import * as rTerminal from './rTerminal';
import * as session from './session';
import * as util from './util';
import * as rstudioapi from './rstudioapi';
import * as rmarkdown from './rmarkdown';
import * as workspaceViewer from './workspaceViewer';
import * as apiImplementation from './apiImplementation';
import * as rHelp from './helpViewer';
import * as completions from './completions';
import * as rShare from './liveShare';
import * as httpgdViewer from './plotViewer';
import * as languageService from './languageService';
import { RTaskProvider } from './tasks';


// global objects used in other files
export const homeExtDir = (): string => util.getDir(path.join(os.homedir(), '.vscode-R'));
export const tmpDir = (): string => util.getDir(path.join(homeExtDir(), 'tmp'));
export let rWorkspace: workspaceViewer.WorkspaceDataProvider | undefined = undefined;
export let globalRHelp: rHelp.RHelp | undefined = undefined;
export let extensionContext: vscode.ExtensionContext;
export let enableSessionWatcher: boolean | undefined = undefined;
export let globalHttpgdManager: httpgdViewer.HttpgdManager | undefined = undefined;
export let rmdPreviewManager: rmarkdown.RMarkdownPreviewManager | undefined = undefined;
export let rmdKnitManager: rmarkdown.RMarkdownKnitManager | undefined = undefined;
export let sessionStatusBarItem: vscode.StatusBarItem | undefined = undefined;

// Called (once) when the extension is activated
export async function activate(context: vscode.ExtensionContext): Promise<apiImplementation.RExtensionImplementation> {
    if (vscode.extensions.getExtension('mikhail-arkhipov.r')) {
        void vscode.window.showInformationMessage('The R Tools (Mikhail-Arkhipov.r) extension is enabled and will have conflicts with vscode-R. To use vscode-R, please disable or uninstall the extension.');
        void vscode.commands.executeCommand('workbench.extensions.search', '@installed R Tools');
    }

    // create a new instance of RExtensionImplementation
    // is used to export an interface to the help panel
    // this export is used e.g. by vscode-r-debugger to show the help panel from within debug sessions
    const rExtension = new apiImplementation.RExtensionImplementation();

    // assign extension context to global variable
    extensionContext = context;

    // assign session watcher setting to global variable
    enableSessionWatcher = util.config().get<boolean>('sessionWatcher') ?? false;
    rmdPreviewManager = new rmarkdown.RMarkdownPreviewManager();
    rmdKnitManager = new rmarkdown.RMarkdownKnitManager();


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
        'r.view': () => rTerminal.runSelectionOrWord(['View']),
        'r.runSource': () => { void rTerminal.runSource(false); },
        'r.runSelection': (code?: string) => { code ? void rTerminal.runTextInTerm(code) : void rTerminal.runSelection(); },
        'r.runFromLineToEnd': rTerminal.runFromLineToEnd,
        'r.runFromBeginningToLine': rTerminal.runFromBeginningToLine,
        'r.runSelectionRetainCursor': rTerminal.runSelectionRetainCursor,
        'r.runCommandWithSelectionOrWord': rTerminal.runCommandWithSelectionOrWord,
        'r.runCommandWithEditorPath': rTerminal.runCommandWithEditorPath,
        'r.runCommand': rTerminal.runCommand,
        'r.runSourcewithEcho': () => { void rTerminal.runSource(true); },

        // chunk related
        'r.selectCurrentChunk': rmarkdown.selectCurrentChunk,
        'r.runCurrentChunk': rmarkdown.runCurrentChunk,
        'r.runCurrentChunkAndMove': rmarkdown.runCurrentChunkAndMove,
        'r.runPreviousChunk': rmarkdown.runPreviousChunk,
        'r.runNextChunk': rmarkdown.runNextChunk,
        'r.runAboveChunks': rmarkdown.runAboveChunks,
        'r.runCurrentAndBelowChunks': rmarkdown.runCurrentAndBelowChunks,
        'r.runBelowChunks': rmarkdown.runBelowChunks,
        'r.runAllChunks': rmarkdown.runAllChunks,
        'r.goToPreviousChunk': rmarkdown.goToPreviousChunk,
        'r.goToNextChunk': rmarkdown.goToNextChunk,
        'r.runChunks': rTerminal.runChunksInTerm,

        // rmd related
        'r.knitRmd': () => { void rmdKnitManager?.knitRmd(false, undefined); },
        'r.knitRmdToPdf': () => { void rmdKnitManager?.knitRmd(false, 'pdf_document'); },
        'r.knitRmdToHtml': () => { void rmdKnitManager?.knitRmd(false, 'html_document'); },
        'r.knitRmdToAll': () => { void rmdKnitManager?.knitRmd(false, 'all'); },

        'r.rmarkdown.newDraft': () => rmarkdown.newDraft(),
        'r.rmarkdown.setKnitDirectory': () => rmdKnitManager?.setKnitDir(),
        'r.rmarkdown.showPreviewToSide': () => rmdPreviewManager?.previewRmd(vscode.ViewColumn.Beside),
        'r.rmarkdown.showPreview': (uri: vscode.Uri) => rmdPreviewManager?.previewRmd(vscode.ViewColumn.Active, uri),
        'r.rmarkdown.preview.refresh': () => rmdPreviewManager?.updatePreview(),
        'r.rmarkdown.preview.openExternal': () => void rmdPreviewManager?.openExternalBrowser(),
        'r.rmarkdown.preview.showSource': () => rmdPreviewManager?.showSource(),
        'r.rmarkdown.preview.toggleStyle': () => rmdPreviewManager?.toggleTheme(),
        'r.rmarkdown.preview.enableAutoRefresh': () => rmdPreviewManager?.enableAutoRefresh(),
        'r.rmarkdown.preview.disableAutoRefresh': () => rmdPreviewManager?.disableAutoRefresh(),

        // file creation (under file submenu)
        'r.rmarkdown.newFileDraft': () => rmarkdown.newDraft(),
        'r.newFileDocument': () => vscode.workspace.openTextDocument({ language: 'r' }).then((v) => vscode.window.showTextDocument(v)),

        // editor independent commands
        'r.createGitignore': rGitignore.createGitignore,
        'r.createLintrConfig': lintrConfig.createLintrConfig,
        'r.generateCCppProperties': cppProperties.generateCppProperties,
        'r.loadAll': () => rTerminal.runTextInTerm('devtools::load_all()'),
        'r.devMode': () => rTerminal.runTextInTerm('devtools::dev_mode()'),
        'r.spellCheck': () => rTerminal.runTextInTerm('devtools::spell_check()'),
        'r.checkRhub': () => rTerminal.runTextInTerm('devtools::check_rhub()'),
        'r.checkWinDevel': () => rTerminal.runTextInTerm('devtools::check_win_devel()'),
        'r.release': () => rTerminal.runTextInTerm('devtools::release()'),
        'r.useVersion': () => rTerminal.runTextInTerm('usethis::use_version()'),
        'r.useCranComments': () => rTerminal.runTextInTerm('usethis::use_cran_comments()'),
        'r.useNewsMd': () => rTerminal.runTextInTerm('usethis::use_news_md()'),
        'r.useGit': () => rTerminal.runTextInTerm('usethis::use_git()'),
        'r.useGitHub': () => rTerminal.runTextInTerm('usethis::use_github()'),
        'r.pkgdownBuildSite': () => rTerminal.runTextInTerm('pkgdown::build_site()'),

        // environment independent commands. this is a workaround for using the Tasks API: https://github.com/microsoft/vscode/issues/40758
        'r.build': () => vscode.commands.executeCommand('workbench.action.tasks.runTask', 'R: Build'),
        'r.buildBinary': () => vscode.commands.executeCommand('workbench.action.tasks.runTask', 'R: Build Binary'),
        'r.check': () => vscode.commands.executeCommand('workbench.action.tasks.runTask', 'R: Check'),
        'r.document': () => vscode.commands.executeCommand('workbench.action.tasks.runTask', 'R: Document'),
        'r.install': () => vscode.commands.executeCommand('workbench.action.tasks.runTask', 'R: Install'),
        'r.test': () => vscode.commands.executeCommand('workbench.action.tasks.runTask', 'R: Test'),

        // interaction with R sessions
        'r.previewDataframe': preview.previewDataframe,
        'r.previewEnvironment': preview.previewEnvironment,
        'r.attachActive': session.attachActive,
        'r.launchAddinPicker': rstudioapi.launchAddinPicker,

        // workspace viewer
        'r.workspaceViewer.refreshEntry': () => rWorkspace?.refresh(),
        'r.workspaceViewer.view': (node: workspaceViewer.GlobalEnvItem) => node?.label && workspaceViewer.viewItem(node.label),
        'r.workspaceViewer.remove': (node: workspaceViewer.GlobalEnvItem) => node?.label && workspaceViewer.removeItem(node.label),
        'r.workspaceViewer.clear': workspaceViewer.clearWorkspace,
        'r.workspaceViewer.load': workspaceViewer.loadWorkspace,
        'r.workspaceViewer.save': workspaceViewer.saveWorkspace,

        // browser controls
        'r.browser.refresh': session.refreshBrowser,
        'r.browser.openExternal': session.openExternalBrowser,

        // (help related commands are registered in rHelp.initializeHelp)
    };
    for (const [key, value] of Object.entries(commands)) {
        context.subscriptions.push(vscode.commands.registerCommand(key, value));
    }


    // keep track of terminals
    context.subscriptions.push(vscode.window.onDidCloseTerminal(rTerminal.deleteTerminal));

    // start language service
    if (util.config().get<boolean>('lsp.enabled')) {
        const lsp = vscode.extensions.getExtension('reditorsupport.r-lsp');
        if (lsp) {
            void vscode.window.showInformationMessage('The R language server extension has been integrated into vscode-R. You need to disable or uninstall REditorSupport.r-lsp and reload window to use the new version.');
            void vscode.commands.executeCommand('workbench.extensions.search', '@installed r-lsp');
        } else {
            context.subscriptions.push(new languageService.LanguageService());
        }
    }

    // register on-enter rule for roxygen comments
    const wordPattern = /(-?\d*\.\d\w*)|([^`~!@$^&*()=+[{\]}\\|;:'",<>/\s]+)/g;
    vscode.languages.setLanguageConfiguration('r', {
        onEnterRules: [
            {
                // Automatically continue roxygen comments: #'
                action: { indentAction: vscode.IndentAction.None, appendText: '#\' ' },
                beforeText: /^\s*#'\s*[^\s]/, // matches a non-empty roxygen line
            },
            {
                // Automatically continue roxygen comments: #'
                action: { indentAction: vscode.IndentAction.None, appendText: '#\' ' },
                beforeText: /^\s*#'/, // matches any roxygen comment line, even an empty one
                previousLineText: /^\s*([^#\s].*|#[^'\s].*|#'\s*[^\s].*|)$/, // matches everything but an empty roxygen line
            },
        ],
        wordPattern,
    });

    // register terminal-provider
    context.subscriptions.push(vscode.window.registerTerminalProfileProvider('r.terminal-profile',
        {
            async provideTerminalProfile() {
                return {
                    options: await rTerminal.makeTerminalOptions()
                };
            }
        }
    ));

    // initialize httpgd viewer
    globalHttpgdManager = httpgdViewer.initializeHttpgd();

    // initialize the package/help related functions
    globalRHelp = await rHelp.initializeHelp(context, rExtension);

    // register codelens and completion providers for r markdown and r files
    vscode.languages.registerCodeLensProvider(['r', 'rmd'], new rmarkdown.RMarkdownCodeLensProvider());
    vscode.languages.registerCompletionItemProvider('rmd', new rmarkdown.RMarkdownCompletionItemProvider(), ' ', ',');
    vscode.languages.registerFoldingRangeProvider('r', new rmarkdown.RChunkFoldingProvider());

    // register (session) hover and completion providers
    vscode.languages.registerHoverProvider(['r', 'rmd'], new completions.HoverProvider());
    vscode.languages.registerHoverProvider(['r', 'rmd'], new completions.HelpLinkHoverProvider());
    vscode.languages.registerCompletionItemProvider(['r', 'rmd'], new completions.StaticCompletionItemProvider(), '@');

    // deploy liveshare listener
    await rShare.initLiveShare(context);

    // register task provider
    const taskProvider = new RTaskProvider();
    vscode.tasks.registerTaskProvider(taskProvider.type, taskProvider);

    // deploy session watcher (if configured by user)
    if (enableSessionWatcher) {
        if (!rShare.isGuestSession) {
            console.info('Initialize session watcher');
            void session.deploySessionWatcher(context.extensionPath);

            // create status bar item that contains info about the session watcher
            console.info('Create sessionStatusBarItem');
            sessionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
            sessionStatusBarItem.command = 'r.attachActive';
            sessionStatusBarItem.text = 'R: (not attached)';
            sessionStatusBarItem.tooltip = 'Click to attach active terminal.';
            sessionStatusBarItem.show();
            context.subscriptions.push(sessionStatusBarItem);
            void session.startRequestWatcher(sessionStatusBarItem);
        }

        // track active text editor
        rstudioapi.trackLastActiveTextEditor(vscode.window.activeTextEditor);
        vscode.window.onDidChangeActiveTextEditor(rstudioapi.trackLastActiveTextEditor);

        // register the R Workspace tree view
        // creates a custom context value for the workspace view
        // only shows view when session watcher is enabled
        rWorkspace = new workspaceViewer.WorkspaceDataProvider();

        // if session watcher is active, register dyamic completion provider
        const liveTriggerCharacters = ['', '[', '(', ',', '$', '@', '"', '\''];
        vscode.languages.registerCompletionItemProvider(['r', 'rmd'], new completions.LiveCompletionItemProvider(), ...liveTriggerCharacters);
    }

    void vscode.commands.executeCommand('setContext', 'r.WorkspaceViewer:show', enableSessionWatcher);

    return rExtension;
}
