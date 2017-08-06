import { HoverProvider, TextDocument, Position, CancellationToken, Hover } from 'vscode';

export class RHoverProvider implements HoverProvider {
    public provideHover(
        document: TextDocument, position: Position, token: CancellationToken):
        Hover {
            console.log("hello");
            return new Hover('I am a hover!');
    }
}