/* eslint-disable @typescript-eslint/no-explicit-any */

interface VsCode {
  postMessage: (msg: OutMessage) => void;
  setState: (state: string) => void;
}


interface IMessage {
  message: string;
}
interface ResizeMessage extends IMessage {
  message: 'resize',
  height: number,
  width: number,
  userTriggered: boolean
}
interface LogMessage extends IMessage {
  message: 'log',
  body: any
}

type OutMessage = ResizeMessage | LogMessage;




interface UpdatePlotMessage extends IMessage {
  message: 'updatePlot',
  svg: string,
  plotId: string
}

interface FocusPlotMessage extends IMessage {
  message: 'focusPlot',
  plotId: string
}

interface ToggleStyleMessage extends IMessage {
  message: 'toggleStyle',
  useOverwrites: boolean
}

type InMessage = UpdatePlotMessage | FocusPlotMessage | ToggleStyleMessage;

