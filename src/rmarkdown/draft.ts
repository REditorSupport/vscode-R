import { QuickPickItem, QuickPickOptions, Uri, window, workspace, env } from 'vscode';
import { extensionContext } from '../extension';
import { executeRCommand, getCurrentWorkspaceFolder, getRpath, ToRStringLiteral, spawnAsync, getConfirmation, catchAsError } from '../util';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

interface TemplateInfo {
    id: string;
    package: string;
    name: string;
    description: string;
    create_dir: boolean;
}

interface TemplateItem extends QuickPickItem {
    info: TemplateInfo;
}

async function getTemplateItems(cwd: string): Promise<TemplateItem[] | undefined> {
    const lim = '---vsc---';
    const rPath = await getRpath();
    if (!rPath) {
        return undefined;
    }
    const options: cp.CommonOptions = {
        cwd: cwd,
        env: {
            ...process.env,
            VSCR_LIM: lim
        }
    };

    const rScriptFile = extensionContext.asAbsolutePath('R/rmarkdown/templates.R');
    const args = [
        '--silent',
        '--no-echo',
        '--no-save',
        '--no-restore',
        '-f',
        rScriptFile
    ];

    try {
        const result = await spawnAsync(rPath, args, options);
        if (result.status !== 0) {
            throw result.error || new Error(result.stderr);
        }
        const re = new RegExp(`${lim}(.*)${lim}`, 'ms');
        const match = re.exec(result.stdout);
        if (!match || match.length !== 2) {
            throw new Error('Could not parse R output.');
        }
        const json = match[1];
        const templates = <TemplateInfo[]>JSON.parse(json) || [];
        const items = templates.map((x) => {
            return {
                alwaysShow: false,
                description: `{${x.package}}`,
                label: x.name + (x.create_dir ? ' $(new-folder)' : ''),
                detail: x.description,
                picked: false,
                info: x
            };
        });
        return items;
    } catch (e) {
        console.log(e);
        void window.showErrorMessage(catchAsError(e).message);
        return undefined;
    }
}

async function launchTemplatePicker(cwd: string): Promise<TemplateItem | undefined> {
    const options: QuickPickOptions = {
        matchOnDescription: true,
        matchOnDetail: true,
        canPickMany: false,
        ignoreFocusOut: false,
        placeHolder: '',
        onDidSelectItem: undefined
    };

    const items = await getTemplateItems(cwd);

    if (items) {
        if (items.length > 0) {
            const selection = await window.showQuickPick<TemplateItem>(items, options);
            return selection;
        } else {
            void window.showInformationMessage('No templates found. Would you like to browse the wiki page for R packages that provide R Markdown templates?', 'Yes', 'No')
                .then((select: string | undefined) => {
                    if (select === 'Yes') {
                        void env.openExternal(Uri.parse('https://github.com/REditorSupport/vscode-R/wiki/R-Markdown#templates'));
                    }
                });
        }
    }
    return undefined;
}

async function makeDraft(file: string, template: TemplateItem, cwd: string): Promise<string | undefined> {
    const fileString = ToRStringLiteral(file, '');
    const cmd = `cat(normalizePath(rmarkdown::draft(file='${fileString}', template='${template.info.id}', package='${template.info.package}', edit=FALSE)))`;
    return await executeRCommand(cmd, cwd, (e: Error) => {
        void window.showErrorMessage(e.message);
        return '';
    });
}

export async function newDraft(): Promise<void> {
    const cwd = getCurrentWorkspaceFolder()?.uri.fsPath ?? os.homedir();
    const template = await launchTemplatePicker(cwd);
    if (!template) {
        return;
    }

    if (template.info.create_dir) {
        let defaultPath = path.join(cwd, 'draft');
        let i = 1;
        while (fs.existsSync(defaultPath)) {
            defaultPath = path.join(cwd, `draft_${++i}`);
        }
        const uri = await window.showSaveDialog({
            defaultUri: Uri.file(defaultPath),
            filters: {
                'Folder': ['']
            },
            saveLabel: 'Create Folder',
            title: 'R Markdown: New Draft'
        });

        if (uri) {
            const parsedPath = path.parse(uri.fsPath);
            const dir = path.join(parsedPath.dir, parsedPath.name);
            if (fs.existsSync(dir)) {
                if (await getConfirmation(`Folder already exists. Are you sure you want to replace the folder?`)) {
                    fs.rmdirSync(dir, { recursive: true });
                } else {
                    return;
                }
            }

            const draftPath = await makeDraft(uri.fsPath, template, cwd);
            if (draftPath) {
                await workspace.openTextDocument(draftPath)
                    .then(document => window.showTextDocument(document));
            }
        }
    } else {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-R-'));
        const tempFile = path.join(tempDir, 'draft.Rmd');
        const draftPath = await makeDraft(tempFile, template, cwd);
        if (draftPath) {
            const text = fs.readFileSync(draftPath, 'utf8');
            await workspace.openTextDocument({ language: 'rmd', content: text })
                .then(document => window.showTextDocument(document));
        }
        fs.rmdirSync(tempDir, { recursive: true });
    }
}
