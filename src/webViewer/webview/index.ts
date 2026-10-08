import { acquireVsCodeApi } from '../webviewMessages';
import { initializeWidgetContent, initializeWidgetState } from './widget';
import type { HtmlViewerPanelReference } from '../webviewMessages';

const script = document.currentScript as HTMLScriptElement;
const vscode = acquireVsCodeApi();
const generation = Number(script.dataset.generation);
initializeWidgetContent(vscode, generation, script.dataset.sessionOwned === 'true');
const state = JSON.parse(script.dataset.viewerState ?? 'null') as HtmlViewerPanelReference | null;
if (state) { initializeWidgetState(vscode, state); }
