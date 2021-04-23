/* eslint-disable @typescript-eslint/no-explicit-any */

// Make sure these files contain the same interfaces as ./html/XXX/webviewMessages.d.ts!


interface VsCode {
  postMessage: (msg: OutMessage) => void;
  setState: (state: string) => void;
}
declare function acquireVsCodeApi(): VsCode;



export interface IOutMessage {
  message: string;
}
export interface ResizeMessage extends IOutMessage {
  message: 'resize',
  height: number,
  width: number,
  userTriggered: boolean
}
export interface LogMessage extends IOutMessage {
  message: 'log',
  body: any
}
export interface MouseClickMessage extends IOutMessage {
  message: 'mouseClick',
  button: number,
  scrollY: number
}
export interface LinkClickedMessage extends IOutMessage {
  message: 'linkClicked',
  href: string,
  scrollY: number
}

export type OutMessage = ResizeMessage | LogMessage | MouseClickMessage | LinkClickedMessage;



export interface InMessage {
  message: 'updatePlot',
  id: 'svg',
  svg: string,
  plotId: string
}
