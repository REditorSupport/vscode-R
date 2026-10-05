import * as vscode from 'vscode';

interface SavedCell {
    kind: vscode.NotebookCellKind;
    value: string;
    language: string;
    metadata: Record<string, unknown>;
    summary?: vscode.NotebookCellExecutionSummary;
    outputs: { metadata?: Record<string, unknown>; items: { mime: string; data: string }[] }[];
}

export const DISPLAY_MIME = 'application/vnd.vscode-r.display+json';

export class InteractiveSerializer implements vscode.NotebookSerializer {
    exportIpynb(data: vscode.NotebookData): Uint8Array {
        const cells = data.cells.map((cell) => ({
            cell_type: cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code',
            source: cell.value,
            metadata: {},
            ...(cell.kind === vscode.NotebookCellKind.Code
                ? {
                      execution_count: cell.executionSummary?.executionOrder ?? null,
                      outputs: (cell.outputs ?? []).flatMap((output): Record<string, unknown>[] => {
                          const stream = output.items.find((item) =>
                              /vnd\.code\.notebook\.(stdout|stderr)$/.test(item.mime),
                          );
                          if (stream) {
                              return [
                                  {
                                      output_type: 'stream',
                                      name: stream.mime.endsWith('stderr') ? 'stderr' : 'stdout',
                                      text: Buffer.from(stream.data).toString(),
                                  },
                              ];
                          }
                          const error = output.items.find(
                              (item) => item.mime === 'application/vnd.code.notebook.error',
                          );
                          if (error) {
                              const value = JSON.parse(Buffer.from(error.data).toString()) as {
                                  name: string;
                                  message: string;
                                  stack?: string;
                              };
                              return [
                                  {
                                      output_type: 'error',
                                      ename: value.name,
                                      evalue: value.message,
                                      traceback: (value.stack ?? '').split('\n'),
                                  },
                              ];
                          }
                          const custom = output.items.find((item) => item.mime === DISPLAY_MIME);
                          const display =
                              custom &&
                              (JSON.parse(Buffer.from(custom.data).toString()) as
                                  | Record<string, unknown>
                                  | undefined);
                          if (display?.kind === 'plot' && Array.isArray(display.pages)) {
                              return (display.pages as Record<string, unknown>[]).map(
                                  (page, index) => {
                                      const mime: Record<string, string> = {
                                          'text/plain': `R plot ${index + 1} of ${(display.pages as unknown[]).length}`,
                                      };
                                      if (typeof page.svgData === 'string') {
                                          mime['image/svg+xml'] = Buffer.from(
                                              page.svgData,
                                              'base64',
                                          ).toString('utf8');
                                      } else if (
                                          typeof page.imageData === 'string' &&
                                          typeof page.mime === 'string'
                                      ) {
                                          mime[page.mime] =
                                              page.mime === 'image/svg+xml'
                                                  ? Buffer.from(page.imageData, 'base64').toString(
                                                        'utf8',
                                                    )
                                                  : page.imageData;
                                      }
                                      return {
                                          output_type: 'display_data',
                                          data: mime,
                                          metadata: {},
                                      };
                                  },
                              );
                          }
                          const mime: Record<string, string> = {};
                          for (const item of output.items) {
                              if (item.mime === DISPLAY_MIME) {
                                  continue;
                              }
                              mime[item.mime] = Buffer.from(item.data).toString(
                                  /^image\/(png|jpeg|gif)$/.test(item.mime) ? 'base64' : 'utf8',
                              );
                          }
                          return [{ output_type: 'display_data', data: mime, metadata: {} }];
                      }),
                  }
                : {}),
        }));
        return Buffer.from(
            JSON.stringify(
                {
                    nbformat: 4,
                    nbformat_minor: 4,
                    metadata: {
                        kernelspec: { name: 'ir', display_name: 'R', language: 'R' },
                        language_info: { name: 'R' },
                    },
                    cells,
                },
                null,
                2,
            ),
        );
    }

    deserializeNotebook(content: Uint8Array): vscode.NotebookData {
        if (!content.length) {
            return new vscode.NotebookData([]);
        }
        const saved = JSON.parse(Buffer.from(content).toString('utf8')) as {
            version: number;
            metadata: Record<string, unknown>;
            cells: SavedCell[];
        };
        if (saved.version !== 1 || !Array.isArray(saved.cells)) {
            throw new Error('Unsupported R Interactive notebook');
        }
        const cells = saved.cells.map((cell) => {
            const data = new vscode.NotebookCellData(cell.kind, cell.value, cell.language);
            data.metadata = cell.metadata;
            data.executionSummary = cell.summary;
            data.outputs = cell.outputs.map(
                (output) =>
                    new vscode.NotebookCellOutput(
                        output.items.map(
                            (item) =>
                                new vscode.NotebookCellOutputItem(
                                    Buffer.from(item.data, 'base64'),
                                    item.mime,
                                ),
                        ),
                        output.metadata,
                    ),
            );
            return data;
        });
        const notebook = new vscode.NotebookData(cells);
        notebook.metadata = saved.metadata;
        return notebook;
    }

    serializeNotebook(data: vscode.NotebookData): Uint8Array {
        const cells: SavedCell[] = data.cells.map((cell) => ({
            kind: cell.kind,
            value: cell.value,
            language: cell.languageId,
            metadata: cell.metadata ?? {},
            summary: cell.executionSummary,
            outputs: (cell.outputs ?? []).map((output) => ({
                metadata: output.metadata,
                items: output.items.map((item) => {
                    let bytes = item.data;
                    if (item.mime === DISPLAY_MIME) {
                        const display = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<
                            string,
                            unknown
                        >;
                        // Forwarding URLs contain transient credentials. Retain asset identities only.
                        for (const page of [
                            display,
                            ...(Array.isArray(display.pages)
                                ? (display.pages as Record<string, unknown>[])
                                : []),
                        ]) {
                            delete page.url;
                            page.connected = false;
                        }
                        bytes = Buffer.from(JSON.stringify(display));
                    }
                    return { mime: item.mime, data: Buffer.from(bytes).toString('base64') };
                }),
            })),
        }));
        return Buffer.from(
            JSON.stringify({ version: 1, metadata: data.metadata ?? {}, cells }, null, 2),
        );
    }
}
