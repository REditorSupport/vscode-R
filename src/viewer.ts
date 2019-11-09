"use strict";

import { commands, ExtensionContext, ViewColumn, window } from "vscode";

export function activate(context: ExtensionContext) {
    context.subscriptions.push(commands.registerCommand("catCoding.start", () => {
        // Create and show panel
        const panel = window.createWebviewPanel("catCoding", "Cat Coding", ViewColumn.One, { });

        // And set its HTML content
        panel.webview.html = getWebviewContent();
    }));
}

function getWebviewContent() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cat Coding</title>
</head>
<body>
    <img src="https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif" width="300" />
</body>
</html>`;
}
