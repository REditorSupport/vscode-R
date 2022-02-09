/* eslint-disable @typescript-eslint/restrict-plus-operands */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { QuickPickItem, QuickPickOptions, window, workspace } from 'vscode';
import { extensionContext } from '../extension';
import { getCurrentWorkspaceFolder, getRpath } from '../util';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { readJSON } from 'fs-extra';

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
    extensionContext.asAbsolutePath('R/rmarkdown/draft.R')
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

async function makeDraft(template: TemplateItem, cwd: string): Promise<string> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-R-'));
  const tempFile = path.join(tempDir, 'draft.Rmd');
  const rPath = await getRpath();
  const options: cp.ExecSyncOptionsWithStringEncoding = {
    cwd: cwd,
    encoding: 'utf-8',
  };

  const args = [
    '--silent',
    '--slave',
    '--no-save',
    '--no-restore',
    '-e',
    `rmarkdown::draft(file='${tempFile}', template='${template.id}', package='${template.package}', edit=FALSE)`,
  ];

  try {
    const result = cp.spawnSync(rPath, args, options);
    if (result.error) {
      throw result.error;
    }

    if (fs.existsSync(tempFile)) {
      const text = fs.readFileSync(tempFile, 'utf-8');
      return text;
    } else {
      throw new Error('Failed to create draft.');
    }
  } catch (e) {
    void window.showErrorMessage((<{ message: string }>e).message);
  } finally {
    fs.rmdirSync(tempDir, { recursive: true });
  }

  return undefined;
}

export async function newDraft(): Promise<void> {
  const cwd = getCurrentWorkspaceFolder()?.uri.fsPath ?? os.homedir();
  const template = await launchTemplatePicker(cwd);
  if (!template) {
    return;
  }

  const text = await makeDraft(template, cwd);
  if (text) {
    void workspace.openTextDocument({ language: 'rmd', content: text });
  }
}
