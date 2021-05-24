/* eslint-disable @typescript-eslint/no-explicit-any */

// Make sure these files contain the same interfaces as ./html/XXX/webviewMessages.d.ts!


interface VsCode {
  postMessage: (msg: OutMessage) => void;
  setState: (state: string) => void;
}
declare function acquireVsCodeApi(): VsCode;



export interface IMessage {
  message: string;
}

export interface ResizeMessage extends IMessage {
  message: 'resize',
  height: number,
  width: number,
  userTriggered: boolean
}
export interface LogMessage extends IMessage {
  message: 'log',
  body: any
}

export type OutMessage = ResizeMessage | LogMessage;



export interface UpdatePlotMessage extends IMessage {
  message: 'updatePlot',
  svg: string,
  plotId: string
}

export interface FocusPlotMessage extends IMessage {
  message: 'focusPlot',
  plotId: string
}

export interface ToggleStyleMessage extends IMessage {
  message: 'toggleStyle',
  useOverwrites: boolean
}

export interface ToggleMultirowMessage extends IMessage {
  message: 'toggleMultirow',
  useMultirow: boolean
}

export interface HidePlotMessage extends IMessage {
  message: 'hidePlot',
  plotId: string
}

export interface AddPlotMessage extends IMessage {
  message: 'addPlot',
  html: string
}

export type InMessage = UpdatePlotMessage | FocusPlotMessage | ToggleStyleMessage | HidePlotMessage | AddPlotMessage | ToggleMultirowMessage;