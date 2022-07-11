export * from './shared';

import { UnixExecLocator } from './unix';
import { WindowsExecLocator } from './windows';
import { AbstractLocatorService } from './shared';



export class LocatorServiceFactory {
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
