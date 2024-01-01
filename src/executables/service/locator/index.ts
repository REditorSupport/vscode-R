'use strict';

import { UnixExecLocator } from './unix';
import { WindowsExecLocator } from './windows';
import { AbstractLocatorService } from './shared';

/**
 * Static class factory for the creation of executable locators
 */
export class LocatorServiceFactory {
    /**
     * Returns a new AbstractLocatorService, dependent on
     * the process' platform
     * @returns instance of AbstractLocatorService
     */
    static getLocator(): AbstractLocatorService {
        if (process.platform === 'win32') {
            return new WindowsExecLocator();
        } else {
            return new UnixExecLocator();
        }
    }

    private constructor() {
        //
    }
}


// TODO
export type TAbstractLocatorService = AbstractLocatorService;