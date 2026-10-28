import { CompletionItemKind, SnippetString, workspace } from 'vscode';
import type { CompletionMiddleware } from 'vscode-languageclient/node';

export const completionMiddleware: CompletionMiddleware = {
    provideCompletionItem: async (document, position, context, token, next) => {
        const result = await next(document, position, context, token);
        if (
            !result ||
            token.isCancellationRequested ||
            !workspace
                .getConfiguration('editor', document)
                .get<boolean>('parameterHints.enabled', true)
        ) {
            return result;
        }

        const items = Array.isArray(result) ? result : result.items;
        for (const item of items) {
            // languageserver inserts a call with the cursor inside its parentheses.
            // Snippet insertion does not fire VS Code's signature-help triggers.
            if (
                !item.command &&
                (item.kind === CompletionItemKind.Function ||
                    item.kind === CompletionItemKind.Method ||
                    item.kind === CompletionItemKind.Constructor) &&
                item.insertText instanceof SnippetString &&
                item.insertText.value.endsWith('($0)')
            ) {
                item.command = {
                    title: 'Trigger parameter hints',
                    command: 'editor.action.triggerParameterHints',
                };
            }
        }
        return result;
    },
};
