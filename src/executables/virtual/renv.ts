import path = require('path');
import { IRenvLock } from '../service/types';
import * as fs from 'fs-extra';

export function getRenvVersion(workspacePath: string): string | undefined {
    if (isRenvWorkspace(workspacePath)) {
        try {
            const lockPath = path.join(workspacePath, 'renv.lock');
            if (!fs.existsSync(lockPath)) {
                return '';
            }
            const lockContent = fs.readJSONSync(lockPath) as IRenvLock;
            return lockContent?.R?.Version ?? '';
        } catch (error) {
            return '';
        }
    } else {
        return undefined;
    }
}

export function isRenvWorkspace(workspacePath: string): boolean {
    try {
        const renvPath = path.join(workspacePath, 'renv');
        return fs.existsSync(renvPath);
    } catch (error) {
        return false;
    }
}