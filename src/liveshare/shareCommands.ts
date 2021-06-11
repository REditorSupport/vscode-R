import * as vsls from 'vsls';
import * as vscode from 'vscode';
import * as fs from 'fs-extra';

import { rHostService, isGuest, service } from '.';
import { updateGuestRequest, updateGuestGlobalenv, updateGuestPlot, detachGuest } from './shareSession';
import { forwardCommands, shareWorkspace } from './shareTree';

import { runTextInTerm } from '../rTerminal';
import { requestFile } from '../session';
import { HelpFile } from '../helpViewer';
import { globalHttpgdManager, globalRHelp } from '../extension';

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
    OrderDetach = 'OrderDetach',
    GetHelpFileContent = 'GetHelpFileContent',
    NotifyGuestPlotManager = 'NotifyGuestPlotManager'
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
            if (shareWorkspace) {
                void rHostService.notifyRequest(requestFile, true);
            } else {
                void liveShareRequest(Callback.NotifyMessage, 'The host has not enabled guest attach.', MessageType.warning);
            }
        },
        [Callback.RequestRunTextInTerm]: (args: [text: string]): void => {
            if (forwardCommands) {
                void runTextInTerm(`${args[0]}`);
            } else {
                void liveShareRequest(Callback.NotifyMessage, 'The host has not enabled command forwarding. Command was not sent.', MessageType.warning);
            }

        },
        [Callback.GetHelpFileContent]: (args: [text: string]): Promise<HelpFile | null> => {
            return globalRHelp.getHelpFileForPath(args[0]);
        },
        /// File Handling ///
        // Host reads content from file, then passes the content
        // to the guest session.
        [Callback.GetFileContent]: async (args: [text: string, encoding?: string]): Promise<string | Buffer> => {
            return args[1] !== undefined ?
                await fs.readFile(args[0], args[1]) :
                await fs.readFile(args[0]);
        }
    },
    'guest': {
        [Callback.NotifyRequestUpdate]: (args: [file: string, force: boolean]): void => {
            void updateGuestRequest(args[0], args[1]);
        },
        [Callback.NotifyEnvUpdate]: (args: [hostEnv: string]): void => {
            void updateGuestGlobalenv(args[0]);
        },
        [Callback.NotifyPlotUpdate]: (args: [file: string]): void => {
            void updateGuestPlot(args[0]);
        },
        [Callback.NotifyGuestPlotManager]: (args: [url: string]): void => {
            globalHttpgdManager?.showViewer(args[0]);
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
export function liveShareOnRequest(name: string, command: unknown, service: vsls.SharedService | vsls.SharedServiceProxy | null): void {
    if (isGuest()) {
        // is guest service
        (service as vsls.SharedServiceProxy).onNotify(name, command as vsls.NotifyHandler);
    } else {
        // is host service
        (service as vsls.SharedService).onRequest(name, command as vsls.RequestHandler);
    }
}

export function liveShareRequest(name: string, ...rest: unknown[]): unknown {
    if (isGuest()) {
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