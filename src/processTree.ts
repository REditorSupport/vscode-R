import childProcess from 'child_process';

export function getProcessQuerySpec(platform: NodeJS.Platform = process.platform): {
    executable: string;
    args: string[];
    timeout: number;
} {
    return platform === 'win32'
        ? {
            executable: 'powershell.exe',
            args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
                'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.ParentProcessId }'],
            timeout: 15000,
        }
        : { executable: 'ps', args: ['-A', '-o', 'pid=', '-o', 'ppid='], timeout: 5000 };
}

/** Return nearest ancestors first, using one bounded process-table snapshot. */
export async function getProcessAncestors(pid: number): Promise<number[]> {
    if (!Number.isSafeInteger(pid) || pid <= 0) { return []; }
    try {
        const { executable, args, timeout } = getProcessQuerySpec();
        const stdout = await new Promise<string>((resolve, reject) => {
            childProcess.execFile(executable, args, {
                // Cold PowerShell/CIM startup on Windows can exceed five seconds.
                encoding: 'utf8', timeout,
                maxBuffer: 4 * 1024 * 1024, windowsHide: true,
            }, (error, output) => error ? reject(error) : resolve(output));
        });
        const parents = new Map<number, number>();
        for (const line of stdout.split(/\r?\n/)) {
            const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
            if (match) { parents.set(Number(match[1]), Number(match[2])); }
        }
        const ancestors: number[] = [];
        const seen = new Set([pid]);
        let parent = parents.get(pid);
        while (parent && !seen.has(parent)) {
            ancestors.push(parent);
            seen.add(parent);
            parent = parents.get(parent);
        }
        return ancestors;
    } catch (error) {
        console.warn('Could not resolve R process ancestors for terminal association', error);
        return [];
    }
}
