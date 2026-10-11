
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

export interface LinkClickedMessage {
    message: 'linkClicked',
    href: string
}

export type OutMessage = LinkClickedMessage
    | { message: 'widget/loaded'; generation: number }
    | { message: 'widget/navigate'; direction: 'back' | 'forward'; generation: number }
    | { message: 'widget/find'; generation: number };
