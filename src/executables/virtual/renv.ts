'use strict';

import * as path from 'path';
import * as fs from 'fs-extra';

export function getRenvVersion(workspacePath: string): string | undefined {
    if (isRenvWorkspace(workspacePath)) {
        try {
            const lockPath = path.join(workspacePath, 'renv.lock');
            if (!fs.existsSync(lockPath)) {
                return '';
            }
            const lockContent = fs.readJSONSync(lockPath) as IRenvJSONLock;
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

type LockPythonType = 'virtualenv' | 'conda' | 'system'

interface IRenvJSONLock {
    R: {
        Version: string,
        Repositories: {
            'Name': string,
            'URL': string
        }[]
    },
    Packages: {
        [key: string]: {
            Package: string,
            Version: string,
            Source: string,
            Repository: string,
            Hash?: string
        }

    },
    Python?: {
        Version: string,
        Type: LockPythonType
        Name?: string
    }
}
