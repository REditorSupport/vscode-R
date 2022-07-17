/* eslint-disable @typescript-eslint/no-explicit-any */
import * as WebSocket from 'ws';

export class SessionSocket extends WebSocket {
    public sendRequest(data: unknown, timeout?: number): Promise<any> {
        return new Promise<any>((resolve) => {
            this.send(JSON.stringify(data));
            this.onmessage = (data) => {
                resolve(JSON.parse(data.data.toString()));
            };
            if (timeout) {
                setTimeout(resolve, timeout);
            }
        });
    }

    public get isConnecting(): boolean {
        return this.readyState === this.CONNECTING;
    }

    public get isOpen(): boolean {
        return this.readyState === this.OPEN;
    }

    public get isClosing(): boolean {
        return this.readyState === this.CLOSING;
    }

    public get isClosed(): boolean {
        return this.readyState === this.CLOSED;
    }
}
