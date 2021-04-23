/* eslint-disable @typescript-eslint/no-explicit-any */

interface VsCode {
  postMessage: (msg: OutMessage) => void;
  setState: (state: string) => void;
}


interface IOutMessage {
  message: string;
}
interface ResizeMessage extends IOutMessage {
  message: 'resize',
  height: number,
  width: number,
  userTriggered: boolean
}
interface LogMessage extends IOutMessage {
  message: 'log',
  body: any
}

type OutMessage = ResizeMessage | LogMessage;



interface InMessage {
  message: 'updatePlot',
  id: 'svg',
  svg: string,
  plotId: string
}
