/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { QuickPickItem, QuickPickOptions, Uri, window, workspace } from 'vscode';
import { extensionContext } from '../extension';
import { executeRCommand, getCurrentWorkspaceFolder, getRpath, ToRStringLiteral } from '../util';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { readJSON } from 'fs-extra';
import { join } from 'path';

interface TemplateItem extends QuickPickItem {
  id: string;
  package: string;
}

async function getTemplateItems(cwd: string): Promise<TemplateItem[]> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-R-'));
  const tempFile = path.join(tempDir, 'templates.json');
  const rPath = await getRpath();
  const options: cp.ExecSyncOptionsWithStringEncoding = {
    cwd: cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      VSCR_FILE: tempFile
    }
  };

  const args = [
    '--silent',
    '--slave',
    '--no-save',
    '--no-restore',
    '-f',
    extensionContext.asAbsolutePath('R/rmarkdown/templates.R')
  ];

  try {
    const result = cp.spawnSync(rPath, args, options);
    if (result.error) {
      throw result.error;
    }

    const templates: any[] = await readJSON(tempFile).then(
      (result) => result,
      () => {
        throw ('Failed to load templates from installed packages.');
      }
    );

    const items = templates.map((x) => {
      return {
        alwaysShow: false,
        description: `{${x.package}}`,
        label: x.name,
        detail: x.description,
        picked: false,
        package: x.package,
        id: x.id,
      };
    });

    return items;
  } catch (e) {
    void window.showErrorMessage((<{ message: string }>e).message);
  } finally {
    fs.rmdirSync(tempDir, { recursive: true });
  }
}

async function launchTemplatePicker(cwd: string): Promise<TemplateItem> {
  const options: QuickPickOptions = {
    matchOnDescription: true,
    matchOnDetail: true,
    canPickMany: false,
    ignoreFocusOut: false,
    placeHolder: '',
    onDidSelectItem: undefined
  };

  const items = await getTemplateItems(cwd);

  const selection: TemplateItem = await window.showQuickPick<TemplateItem>(items, options);
  return selection;
}

async function makeDraft(file: string, template: TemplateItem, cwd: string): Promise<string> {
  const fileString = ToRStringLiteral(file, '');
  const cmd = `cat(normalizePath(rmarkdown::draft(file='${fileString}', template='${template.id}', package='${template.package}', edit=FALSE)))`;
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

  const uri = await window.showSaveDialog({
    defaultUri: Uri.file(join(cwd, 'draft.Rmd')),
    filters: {
      'R Markdown': ['Rmd', 'rmd']
    },
    saveLabel: 'Create Draft',
    title: 'R Markdown: New Draft'
  });

  if (uri) {
    const draftPath = await makeDraft(uri.fsPath, template, cwd);
    if (draftPath) {
      await workspace.openTextDocument(draftPath)
        .then(document => window.showTextDocument(document));
    }
  }
}
