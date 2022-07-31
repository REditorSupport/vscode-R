
interface LockPackage {
    Package: string,
    Version: string,
    Source: string,
    Repository: string,
    Hash?: string
}

interface LockRepository {
    'Name': string,
    'URL': string
}

type LockPythonType = 'virtualenv' | 'conda' | 'system'

export interface IRenvJSONLock {
    R: {
        Version: string,
        Repositories: LockRepository[]
    },
    Packages: {
        [key: string]: LockPackage
    },
    Python?: {
        Version: string,
        Type: LockPythonType
        Name?: string
    }
}
