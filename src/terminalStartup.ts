export type TerminalStartupStatus = 'pending' | 'ready' | 'failed';

export interface TerminalStartupRecord {
    token: string;
    attemptId: string;
    pid: number;
    endpoint: string;
    status: TerminalStartupStatus;
}

export type TerminalStartupObservation = TerminalStartupStatus | 'unknown' | 'attempt-changed';

export interface TerminalStartupDecision {
    observation: TerminalStartupObservation;
    attemptId?: string;
    readyForOwner: boolean;
}

const PROTOCOL = 'vscode-r-terminal-startup-v1';
const MAX_RECORD_BYTES = 512;

/** Parse the small base-R sidecar without accepting partial or cross-terminal records. */
export function parseTerminalStartupRecord(contents: string, expectedToken: string): TerminalStartupRecord | undefined {
    if (Buffer.byteLength(contents, 'utf8') > MAX_RECORD_BYTES) { return; }
    const lines = contents.replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) !== '') { return; }
    lines.pop();
    if (lines.length !== 6 || lines[0] !== PROTOCOL || lines[1] !== expectedToken) { return; }
    if (!/^[a-f0-9]{32}$/.test(lines[1])) { return; }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(lines[2])) { return; }
    if (!/^[1-9][0-9]*$/.test(lines[3])) { return; }
    const pid = Number(lines[3]);
    if (!Number.isSafeInteger(pid)) { return; }
    if (!lines[4] || /[\r\n]/.test(lines[4])) { return; }
    if (lines[5] !== 'pending' && lines[5] !== 'ready' && lines[5] !== 'failed') { return; }
    return { token: lines[1], attemptId: lines[2], pid, endpoint: lines[4], status: lines[5] };
}

/** A wait belongs to one setup attempt; a later attempt cannot release its queued input. */
export function assessTerminalStartup(
    previousAttemptId: string | undefined,
    record: TerminalStartupRecord | undefined,
    ownerPid: string | undefined,
    ownerEndpoint: string | undefined,
): TerminalStartupDecision {
    if (!record) { return { observation: 'unknown', attemptId: previousAttemptId, readyForOwner: false }; }
    if (previousAttemptId !== undefined && previousAttemptId !== record.attemptId) {
        return { observation: 'attempt-changed', attemptId: record.attemptId, readyForOwner: false };
    }
    const ownerMatches = Boolean(ownerPid && /^[1-9][0-9]*$/.test(ownerPid) && Number(ownerPid) === record.pid
        && ownerEndpoint === record.endpoint);
    return {
        observation: record.status,
        attemptId: record.attemptId,
        readyForOwner: record.status === 'ready' && ownerMatches,
    };
}
