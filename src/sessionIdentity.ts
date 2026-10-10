/** Session IDs identify a process lifetime; host and PID guard against ID reuse. */
export function sessionProcessIdentity(source: { readonly sessionId: string; readonly host: string; readonly pid: string }): string {
    return JSON.stringify([source.sessionId, source.host.toLowerCase(), source.pid]);
}
