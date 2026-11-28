import { AbstractMessageReader, AbstractMessageWriter, Emitter, Message } from 'vscode-jsonrpc';
import type { DataCallback, MessageReader, MessageWriter } from 'vscode-jsonrpc';
import type { WebRLanguageSession } from './languageSession';

/** The same decoded JSON-RPC transport is used by the browser and Node language clients. */
export function createWebRMessageTransports(session: WebRLanguageSession): {
    reader: MessageReader;
    writer: MessageWriter;
} {
    const messages = new Emitter<Message>();
    const requests = new Map<number | string, { cancelled: boolean }>();
    let queue = Promise.resolve();
    let closed = false;
    function close() {
        if (closed) {
            return;
        }
        closed = true;
        requests.clear();
        messages.dispose();
        session.close();
    }
    const reader = new (class extends AbstractMessageReader {
        disconnect() {
            this.fireClose();
            close();
        }
        listen(callback: DataCallback) {
            return messages.event(callback);
        }
        override dispose() {
            close();
            super.dispose();
        }
    })();
    const writer = new (class extends AbstractMessageWriter {
        write(message: Message): Promise<void> {
            if (closed) {
                return Promise.reject(new Error('The webR language server has closed.'));
            }
            if (Message.isNotification(message) && message.method === '$/cancelRequest') {
                const id = (message.params as { id?: number | string } | undefined)?.id;
                const request = id === undefined ? undefined : requests.get(id);
                if (request && !request.cancelled) {
                    request.cancelled = true;
                    const reply = {
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32800, message: 'Request cancelled' },
                    };
                    messages.fire(reply);
                }
                return Promise.resolve();
            }
            const id = Message.isRequest(message) ? message.id : null;
            const request = { cancelled: false };
            if (id !== null) {
                requests.set(id, request);
            }
            const dispatch = queue
                .then(async () => {
                    if (closed || request.cancelled) {
                        return;
                    }
                    const replies = await session.dispatch(message);
                    if (!closed) {
                        for (const reply of replies) {
                            if (
                                !request.cancelled ||
                                !Message.isResponse(reply) ||
                                reply.id !== id
                            ) {
                                messages.fire(reply);
                            }
                        }
                    }
                })
                .finally(() => {
                    if (id !== null && requests.get(id) === request) {
                        requests.delete(id);
                    }
                });
            queue = dispatch.catch((error: unknown) => {
                if (!closed) {
                    this.fireError(error, message);
                    reader.disconnect();
                }
            });
            // A request write acknowledges admission; cancellation can arrive while R is busy.
            // Wait for exit itself so client disposal cannot close the worker before shutdown finishes.
            return Message.isNotification(message) && message.method === 'exit'
                ? dispatch
                : Promise.resolve();
        }
        end() {
            void queue.then(close);
        }
        override dispose() {
            close();
            super.dispose();
        }
    })();
    return { reader, writer };
}
