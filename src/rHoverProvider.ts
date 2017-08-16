import { HoverProvider, TextDocument, Position, CancellationToken, Hover } from 'vscode';
import cp = require('child_process');
import { config, getRpath } from './util';


export class RHoverProvider implements HoverProvider {
    public provideHover(
        document: TextDocument, position: Position, token: CancellationToken):
        Hover {
            let wordRange = document.getWordRangeAtPosition(position);
                let rPath: string = <string>config.get('lintr.executable');
            if (!rPath)  {
                rPath = getRpath();
            }
            if (!rPath) {
                return;
            }


            let rCommand = "str(" + document.getText(wordRange) + ")";
            if (process.platform === 'win32') {
                rPath =  ToRStringLiteral(rPath, '');
            }
            const parameters = [
                '--vanilla', '--slave',
                '--no-save',
                '-e',
                rCommand,
                '--args'
            ];
            let output = "hello";
            cp.execFile(rPath, parameters, (error, stdout, stderr) => {
                if (stderr) {
                    console.log("stderr:" + stderr.toString());
                }
                if (stdout) {
                    console.log(stdout);
                    output = stdout;
                    return new Hover(output);
                } else {
                    output = "world";
                    return new Hover(output);
                }
            });
            // console.log(output);
    }
}

function ToRStringLiteral(s: string, quote: string) {
    if (s === null) {
        return "NULL";
    }
        return (quote +
            s.replace(/\\/g, "\\\\")
            .replace(/"""/g, "\\" + quote)
            .replace(/\\n/g, "\\n")
            .replace(/\\r/g, "\\r")
            .replace(/\\t/g, "\\t")
            .replace(/\\b/g, "\\b")
            .replace(/\\a/g, "\\a")
            .replace(/\\f/g, "\\f")
            .replace(/\\v/g, "\\v") +
            quote);
}