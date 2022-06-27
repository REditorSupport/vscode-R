/* eslint-disable @typescript-eslint/no-explicit-any */

interface VsCode {
  postMessage: (msg: OutMessage) => void;
  setState: (state: string) => void;
}


interface IOutMessage {
  message: string;
}
interface LogMessage extends IOutMessage {
  message: 'log',
  body: any
}
interface MouseClickMessage extends IOutMessage {
  message: 'mouseClick',
  button: number,
  scrollY: number
}
interface LinkClickedMessage extends IOutMessage {
  message: 'linkClicked',
  href: string,
  scrollY: number
}
interface CodeClickedMessage extends IOutMessage {
  message: 'codeClicked',
  code: string
}

type OutMessage = LogMessage | MouseClickMessage | LinkClickedMessage | CodeClickedMessage;

