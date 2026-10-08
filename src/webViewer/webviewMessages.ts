
import type { ViewerSessionSource } from '../viewerSession';

export interface HtmlViewerPanelState {
    id: string;
    version: 1;
    source?: ViewerSessionSource;
    history: Array<{ file: string; title: string }>;
    index: number;
    showSessionInfo: boolean;
}

export type HtmlViewerPanelReference = Pick<HtmlViewerPanelState, 'id'>;

export interface VsCode {
    postMessage: (msg: OutMessage) => void;
    setState: (state: unknown) => void;
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

export type OutMessage = LogMessage | MouseClickMessage | LinkClickedMessage
    | { message: 'viewer-session/ready' }
    | { message: 'widget/navigate'; direction: 'back' | 'forward'; generation: number }
    | { message: 'widget/find'; generation: number };
