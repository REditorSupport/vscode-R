import childProcess from 'child_process';

/** Return nearest ancestors first, using one bounded process-table snapshot. */
export async function getProcessAncestors(pid: number): Promise<number[]> {
    if (!Number.isSafeInteger(pid) || pid <= 0) { return []; }
    try {
        const executable = process.platform === 'win32' ? 'powershell.exe' : 'ps';
        const args = process.platform === 'win32'
            ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
                'Get-CimInstance Win32_Process | ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.ParentProcessId }']
            : ['-A', '-o', 'pid=', '-o', 'ppid='];
        const stdout = await new Promise<string>((resolve, reject) => {
            childProcess.execFile(executable, args, {
                encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
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
