/* eslint-disable @typescript-eslint/no-explicit-any */

export interface VsCode {
    postMessage: (msg: OutMessage) => void;
    setState: (state: string) => void;
}
/**
 * Function declared by VS Code in Webview
 */
export const acquireVsCodeApi: () => VsCode = (globalThis as { acquireVsCodeApi?: () => VsCode }).acquireVsCodeApi || (() => ({} as VsCode));

export interface IMessage {
    message: string;
}

export interface LogMessage extends IMessage {
    message: 'log',
    body: any
}
export interface MouseClickMessage extends IMessage {
    message: 'mouseClick',
    button: number,
    scrollY: number
}
export interface LinkClickedMessage extends IMessage {
    message: 'linkClicked',
    href: string,
    scrollY: number
}
export interface CodeClickedMessage extends IMessage {
    message: 'codeClicked',
    code: string,
    modifiers: {
        altKey: boolean,
        ctrlKey: boolean,
        shiftKey: boolean,
        metaKey: boolean,
    }
}
export interface GetScrollYMessage extends IMessage {
    message: 'getScrollY',
    scrollY: number
}

export type OutMessage = LogMessage | MouseClickMessage | LinkClickedMessage | CodeClickedMessage | GetScrollYMessage;
