/** The extension host supplies the runtime on both desktop and remote hosts. */
export interface NodeRuntime {
    executable: string;
    electron: boolean;
}

export function hostNodeRuntime(): NodeRuntime {
    return { executable: process.execPath, electron: !!process.versions.electron };
}
