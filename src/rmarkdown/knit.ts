import * as util from '../util';
import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { RMarkdownManager, KnitWorkingDirectory } from './manager';
import { runTextInTerm } from '../rTerminal';
import { extensionContext, rmdPreviewManager } from '../extension';
import { DisposableProcess } from '../util';

export let knitDir: KnitWorkingDirectory | undefined;

interface IKnitQuickPickItem {
    label: string,
    description: string,
    detail: string,
    value: KnitWorkingDirectory
}

interface IYamlFrontmatter {
    title?: string,
    author?: string,
    knit?: string,
    site?: string,
    [key: string]: unknown
}

export class RMarkdownKnitManager extends RMarkdownManager {
    constructor() {
        super();
        knitDir = util.config().get<KnitWorkingDirectory>('rmarkdown.knit.defaults.knitWorkingDirectory') ?? undefined;
    }


    private async renderDocument(rDocumentPath: string, docPath: string, docName: string, yamlParams: IYamlFrontmatter, outputFormat?: string): Promise<DisposableProcess | undefined> {
        const openOutfile: boolean = util.config().get<boolean>('rmarkdown.knit.openOutputFile') ?? false;
        const knitWorkingDir = this.getKnitDir(knitDir, docPath);
        const knitWorkingDirText = knitWorkingDir ? `${knitWorkingDir}` : '';
        const knitCommand = await this.getKnitCommand(yamlParams, rDocumentPath, outputFormat);
        if (!knitCommand) {
            return;
        }
        this.rPath = await util.getRpath();

        const lim = '<<<vsc>>>';
        const re = new RegExp(`.*${lim}(.*)${lim}.*`, 'gms');
        const scriptValues = {
            'VSCR_KNIT_DIR': knitWorkingDirText,
            'VSCR_LIM': lim,
            'VSCR_KNIT_COMMAND': knitCommand
        };

        const callback = (dat: string) => {
            const outputUrl = re.exec(dat)?.[0]?.replace(re, '$1');
            if (!outputUrl) {
                return false;
            }
            if (openOutfile) {
                const outFile = vscode.Uri.file(outputUrl);
                if (fs.existsSync(outFile.fsPath)) {
                    void vscode.commands.executeCommand('vscode.open', outFile);
                } else {
                    void vscode.window.showWarningMessage(`Could not find the output file at path: "${outFile.fsPath}"`);
                }
            }
            return true;
        };

        if (util.config().get<boolean>('rmarkdown.knit.focusOutputChannel')) {
            this.rMarkdownOutput.show(true);
        }

        return await this.knitWithProgress(
            {
                workingDirectory: knitWorkingDirText,
                fileName: docName,
                filePath: rDocumentPath,
                scriptArgs: scriptValues,
                scriptPath: extensionContext.asAbsolutePath('R/rmarkdown/knit.R'),
                rCmd: knitCommand,
                rOutputFormat: outputFormat,
                callback: callback
            }
        );

    }

    private getYamlFrontmatter(docPath: string): IYamlFrontmatter {
        const text = fs.readFileSync(docPath, 'utf8');
        const lines = text.split('\n');
        let startLine = -1;
        let endLine = -1;
        for (let i = 0; i < lines.length; i++) {
            if (/\S/.test(lines[i])) {
                if (startLine < 0) {
                    if (lines[i].startsWith('---')) {
                        startLine = i;
                    } else {
                        break;
                    }
                } else {
                    if (lines[i].startsWith('---')) {
                        endLine = i;
                        break;
                    }
                }
            }
        }

        let yamlText: string | undefined = undefined;
        if (startLine + 1 < endLine) {
            yamlText = lines.slice(startLine + 1, endLine).join('\n');
        }

        let paramObj: IYamlFrontmatter = {};
        if (yamlText) {
            try {
                paramObj = yaml.load(
                    yamlText
                ) as IYamlFrontmatter;
            } catch (e) {
                console.error(`Could not parse YAML frontmatter for "${docPath}". Error: ${String(e)}`);
            }
        }

        return paramObj;
    }

    private async getKnitCommand(yamlParams: IYamlFrontmatter, docPath: string, outputFormat?: string): Promise<string | undefined> {
        let knitCommand: string;

        if (!yamlParams?.['site']) {
            yamlParams['site'] = await this.findSiteParam();
        }

        // precedence:
        // knit > site > configuration
        if (yamlParams?.['knit']) {
            const knitParam = yamlParams['knit'].trim();
            knitCommand = outputFormat ?
                `${knitParam}(${docPath}, output_format = '${outputFormat}')` :
                `${knitParam}(${docPath})`;
        } else if (!this.isREADME(docPath) && yamlParams?.['site']) {
            knitCommand = outputFormat ?
                `rmarkdown::render_site(${docPath}, output_format = '${outputFormat}')` :
                `rmarkdown::render_site(${docPath})`;
        } else {
            const cmd = util.config().get<string>('rmarkdown.knit.command');
            if (!cmd) {
                return;
            }
            knitCommand = outputFormat ?
                `${cmd}(${docPath}, output_format = '${outputFormat}')` :
                `${cmd}(${docPath})`;
        }

        return knitCommand.replace(/['"]/g, '\'');
    }

    // check if the workspace of the document is a R Markdown site.
    // the definition of what constitutes an R Markdown site differs
    // depending on the type of R Markdown site (i.e., "simple" vs. blogdown sites)
    private async findSiteParam(): Promise<string | undefined> {
        const wad = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!wad) {
            return;
        }
        const rootFolder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? path.dirname(wad);
        const indexFile = (await vscode.workspace.findFiles(new vscode.RelativePattern(rootFolder, 'index.{Rmd,rmd, md}'), null, 1))?.[0];
        const siteRoot = path.join(path.dirname(wad), '_site.yml');

        // 'Simple' R Markdown websites require all docs to be in the root folder
        if (fs.existsSync(siteRoot)) {
            return 'rmarkdown::render_site';
            // Other generators may allow for docs in subdirs
        } else if (indexFile) {
            const indexData = this.getYamlFrontmatter(indexFile.fsPath);
            if (indexData?.['site']) {
                return indexData['site'];
            }
        }

        return undefined;
    }

    // readme files should not be knitted via render_site
    private isREADME(docPath: string) {
        return !!path.basename(docPath).includes('README');
    }

    // alters the working directory for evaluating chunks
    public setKnitDir(): void {
        const textEditor = vscode.window.activeTextEditor;
        const currentDocumentWorkspacePath: string | undefined = textEditor ? vscode.workspace.getWorkspaceFolder(textEditor.document.uri)?.uri.fsPath : undefined;
        const currentDocumentFolderPath: string | undefined = textEditor ? path.dirname(textEditor.document.uri.fsPath) : undefined;
        const items: IKnitQuickPickItem[] = [];

        if (currentDocumentWorkspacePath) {
            items.push(
                {
                    label: (knitDir === KnitWorkingDirectory.workspaceRoot ? '$(check)' : '') + KnitWorkingDirectory.workspaceRoot,
                    value: KnitWorkingDirectory.workspaceRoot,
                    detail: 'Use the workspace root as the knit working directory',
                    description: currentDocumentWorkspacePath ?? currentDocumentFolderPath ?? 'No available workspace'
                }
            );
        }

        if (currentDocumentFolderPath && currentDocumentFolderPath !== '.') {
            items.push(
                {
                    label: (knitDir === KnitWorkingDirectory.documentDirectory ? '$(check)' : '') + KnitWorkingDirectory.documentDirectory,
                    value: KnitWorkingDirectory.documentDirectory,
                    detail: 'Use the document\'s directory as the knit working directory',
                    description: currentDocumentFolderPath ?? 'No folder available'

                }
            );
        }

        if (items.length > 0) {
            void vscode.window.showQuickPick(
                items,
                {
                    title: 'Set knit working directory',
                    canPickMany: false
                }
            ).then(async choice => {
                if (choice?.value && knitDir !== choice.value) {
                    knitDir = choice.value;
                    await rmdPreviewManager?.updatePreview();
                }
            });
        } else {
            void vscode.window.showInformationMessage('Cannot set knit directory for untitled documents.');
        }

    }

    public async knitRmd(echo: boolean, outputFormat?: string): Promise<void> {
        const textEditor = vscode.window.activeTextEditor;
        if (!textEditor) {
            void vscode.window.showWarningMessage('No text editor active.');
            return;
        }

        const wad: vscode.TextDocument = textEditor.document;

        // handle untitled rmd
        if (textEditor.document.isUntitled) {
            void vscode.window.showWarningMessage('Cannot knit an untitled file. Please save the document.');
            await vscode.commands.executeCommand('workbench.action.files.save').then(() => {
                if (!textEditor.document.isUntitled) {
                    void this.knitRmd(echo, outputFormat);
                }
            });
            return;
        }

        const isSaved = await util.saveDocument(wad);
        if (!isSaved) {
            return;
        }
        let rDocumentPath = util.ToRStringLiteral(wad.fileName, '"');

        if (echo) {
            rDocumentPath = [rDocumentPath, 'echo = TRUE'].join(', ');
        }

        // allow users to opt out of background process
        if (util.config().get<boolean>('rmarkdown.knit.useBackgroundProcess')) {
            const busyPath = wad.uri.fsPath + (outputFormat ?? '');
            if (this.busyUriStore.has(busyPath)) {
                return;
            }
            this.busyUriStore.add(busyPath);
            await this.renderDocument(
                rDocumentPath,
                wad.uri.fsPath,
                path.basename(wad.uri.fsPath),
                this.getYamlFrontmatter(wad.uri.fsPath),
                outputFormat
            );
            this.busyUriStore.delete(busyPath);
        } else {
            if (outputFormat === undefined) {
                void runTextInTerm(`rmarkdown::render(${rDocumentPath})`);
            } else {
                void runTextInTerm(`rmarkdown::render(${rDocumentPath}, '${outputFormat}')`);
            }
        }
    }
}
