import * as vsls from 'vsls';
import * as vscode from 'vscode';
import * as fs from 'fs-extra';

import { rHostService, isGuest, service } from './rShare';
import { updateGuestRequest, updateGuestGlobalenv, updateGuestPlot, detachGuest } from './rShareSession';
import { forwardCommands, shareWorkspace } from './rShareTree';
import { runTextInTerm } from './rTerminal';
import { requestFile } from './session';
import { doesTermExist } from './util';

// used in sending messages to the guest service,
// distinguishes the type of vscode message to show
const enum MessageType {
    information = 'information',
    error = 'error',
    warning = 'warning'
}

interface ICommands {
    host: {
        [name: string]: unknown
    },
    guest: {
        [name: string]: unknown
    }
}

// used for notify & request events
// (mainly to prevent typos)
export const enum Callback {
    NotifyEnvUpdate = 'NotifyEnvUpdate',
    NotifyPlotUpdate = 'NotifyPlotUpdate',
    NotifyRequestUpdate = 'NotifyRequestUpdate',
    NotifyMessage = 'NotifyMessage',
    RequestAttachGuest = 'RequestAttachGuest',
    RequestRunTextInTerm = 'RequestRunTextInTerm',
    GetFileContent = 'GetFileContent',
    OrderDetach = 'OrderDetach'
}

// To contribute a request between the host and guest,
// add the method that will be triggered with the callback.
// method arguments should be defined as an array of 'args'
//
// A response should have the this typical structure:
// [Callback.name]: (args:[]): returnType => {
//   method
// }
//
// A request, by comparison, may look something like this:
// method(args) {
//      await request(Callback.name, args)
// }
export const Commands: ICommands = {
    'host': {
        /// Terminal commands ///
        // Command arguments are sent from the guest to the host,
        // and then the host sends the arguments to the console
        [Callback.RequestAttachGuest]: (): void => {
            if (shareWorkspace === true) {
                if (doesTermExist() === true) {
                    const req = requestFile;
                    void rHostService.notifyRequest(req, true);
                } else {
                    void request(Callback.NotifyMessage, 'Cannot attach guest terminal. Must have active host R terminal.', MessageType.error);
                }
            } else {
                void request(Callback.NotifyMessage, 'The host has not enabled guest attach.', MessageType.warning);
            }
        },
        [Callback.RequestRunTextInTerm]: (args: [text: string]): void => {
            if (forwardCommands === true) {
                if (doesTermExist() === true) {
                    void runTextInTerm(`${args[0]}`);
                } else {
                    void request(Callback.NotifyMessage, 'Cannot call command. Must have active host R terminal.', MessageType.warning);
                }
            } else {
                void request(Callback.NotifyMessage, 'The host has not enabled command forwarding. Command was not sent.', MessageType.warning);
            }

        },
        /// File Handling ///
        // Host reads content from file, then passes the content
        // to the guest session.
        [Callback.GetFileContent]: async (args: [text: string, encoding?: string]): Promise<string | Buffer> => {
            if (typeof (args[1]) !== 'undefined') {
                return await fs.readFile(args[0], args[1]);
            } else {
                return await fs.readFile(args[0]);
            }
        }
    },
    'guest': {
        [Callback.NotifyRequestUpdate]: (args: [file: string, force: boolean]): void => {
            void updateGuestRequest(args[0], args[1]);
        },
        [Callback.NotifyEnvUpdate]: (args: [file: string]): void => {
            void updateGuestGlobalenv(args[0]);
        },
        [Callback.NotifyPlotUpdate]: (args: [file: string]): void => {
            void updateGuestPlot(args[0]);
        },
        [Callback.OrderDetach]: (): void => {
            void detachGuest();
        },
        /// vscode Messages ///
        // The host sends messages to the guest, which are displayed as a vscode window message
        // E.g., teling the guest a terminal is not attached to the current session
        // This way, we don't have to do much error checking on the guests side, which is more secure
        // and less prone to error
        [Callback.NotifyMessage]: (args: [text: string, messageType: MessageType]): void => {
            switch (args[1]) {
                case MessageType.error:
                    return void vscode.window.showErrorMessage(args[0]);
                case MessageType.information:
                    return void vscode.window.showInformationMessage(args[0]);
                case MessageType.warning:
                    return void vscode.window.showWarningMessage(args[0]);
                case undefined:
                    return void vscode.window.showInformationMessage(args[0]);
            }
        }
    }
};


// The following onRequest and request methods are wrappers
// around the vsls RPC API. These are intended to simplify
// the API, so that the learning curve is minimal for contributing
// future callbacks.
//
// You can see that the onNotify and notify methods have been
// aggregated under these two methods. This is because the host service
// has no request methods, and for *most* purposes, there is little functional
// difference between request and notify.
export async function onRequest(name: string, command: unknown, service: vsls.SharedService | vsls.SharedServiceProxy | null): Promise<void> {
    if (await isGuest()) {
        // is guest service
        (service as vsls.SharedServiceProxy).onNotify(name, command as vsls.NotifyHandler);
    } else {
        // is host service
        (service as vsls.SharedService).onRequest(name, command as vsls.RequestHandler);
    }
}

export async function request(name: string, ...rest: unknown[]): Promise<unknown> {
    if (await isGuest()) {
        if (rest !== undefined) {
            return (service as vsls.SharedServiceProxy).request(name, rest);
        } else {
            return (service as vsls.SharedServiceProxy).request(name, []);
        }
    } else {
        if (rest !== undefined) {
            return (service as vsls.SharedService).notify(name, { ...rest });
        } else {
            return (service as vsls.SharedService).notify(name, {});
        }
    }
}