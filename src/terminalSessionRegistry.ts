export interface TerminalAssociation<Session, Terminal> {
    readonly session: Session;
    readonly terminal: Terminal;
    readonly kind: 'native' | 'explicit';
}

/** Each session and terminal has at most one association; replacement leaves no fallback. */
export class TerminalSessionRegistry<Session, Terminal extends object> {
    private readonly byTerminal = new Map<Terminal, TerminalAssociation<Session, Terminal>>();
    private readonly bySession = new Map<Session, TerminalAssociation<Session, Terminal>>();
    private readonly revisions = new WeakMap<Terminal, number>();
    private readonly closed = new WeakSet<Terminal>();
    private readonly listeners = new Set<(terminal: Terminal) => void>();

    constructor(
        private readonly isConnected: (session: Session) => boolean,
        private readonly isOpen: (terminal: Terminal) => boolean,
    ) {}

    isClosed(terminal: Terminal): boolean { return this.closed.has(terminal); }

    isLive(terminal: Terminal): boolean { return !this.isClosed(terminal) && this.isOpen(terminal); }

    associationFor(terminal: Terminal | undefined): TerminalAssociation<Session, Terminal> | undefined {
        if (!terminal || !this.isLive(terminal)) { return undefined; }
        const association = this.byTerminal.get(terminal);
        return association && this.isConnected(association.session) ? association : undefined;
    }

    ownerOf(terminal: Terminal | undefined): Session | undefined { return this.associationFor(terminal)?.session; }

    forSession(session: Session): TerminalAssociation<Session, Terminal> | undefined {
        const association = this.bySession.get(session);
        return association && this.isCurrent(association) ? association : undefined;
    }

    isCurrent(association: TerminalAssociation<Session, Terminal>): boolean {
        return this.associationFor(association.terminal) === association
            && this.bySession.get(association.session) === association;
    }

    /** A native PID lookup may commit only if ownership did not change while it waited. */
    snapshot(terminal: Terminal): () => boolean {
        const revision = this.revisions.get(terminal) ?? 0;
        return () => this.isLive(terminal) && (this.revisions.get(terminal) ?? 0) === revision;
    }

    bindExplicit(terminal: Terminal, session: Session): boolean {
        if (!this.isLive(terminal) || !this.isConnected(session)) { return false; }
        const current = this.associationFor(terminal);
        if (current?.kind === 'explicit' && current.session === session) { return true; }
        this.set(terminal, session, 'explicit');
        return true;
    }

    attachNative(terminal: Terminal, session: Session): boolean {
        if (!this.isLive(terminal) || !this.isConnected(session)
            || this.associationFor(terminal)?.kind === 'explicit'
            || this.forSession(session)?.kind === 'explicit') { return false; }
        this.set(terminal, session, 'native');
        return true;
    }

    releaseSession(session: Session): void {
        const association = this.bySession.get(session);
        if (association) { this.remove(association.terminal); }
    }

    closeTerminal(terminal: Terminal): void {
        if (this.isClosed(terminal)) { return; }
        this.closed.add(terminal);
        this.remove(terminal);
    }

    onDidChange(listener: (terminal: Terminal) => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    private set(terminal: Terminal, session: Session, kind: 'native' | 'explicit'): void {
        const previous = this.bySession.get(session);
        const displaced = this.byTerminal.get(terminal);
        const changed = new Set<Terminal>();
        if (previous) {
            this.byTerminal.delete(previous.terminal);
            changed.add(previous.terminal);
        }
        if (displaced) { this.bySession.delete(displaced.session); }
        const association = { terminal, session, kind };
        this.byTerminal.set(terminal, association);
        this.bySession.set(session, association);
        changed.add(terminal);
        this.changed(...changed);
    }

    private remove(terminal: Terminal): void {
        const association = this.byTerminal.get(terminal);
        this.byTerminal.delete(terminal);
        if (association) { this.bySession.delete(association.session); }
        this.changed(terminal);
    }

    private changed(...terminals: Terminal[]): void {
        // Publish complete ownership and invalidate all affected lookups before notifying.
        for (const terminal of terminals) {
            this.revisions.set(terminal, (this.revisions.get(terminal) ?? 0) + 1);
        }
        for (const terminal of terminals) {
            for (const listener of this.listeners) { listener(terminal); }
        }
    }
}
