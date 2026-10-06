export interface TerminalAssociation<Session, Terminal> {
    readonly session: Session;
    readonly terminal: Terminal;
    readonly kind: 'native' | 'explicit';
}

/** Current ownership only: replacing an association never leaves a fallback owner. */
export class TerminalSessionRegistry<Session, Terminal extends object> {
    private readonly associations = new Map<Terminal, TerminalAssociation<Session, Terminal>>();
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
        const association = this.associations.get(terminal);
        return association && this.isConnected(association.session) ? association : undefined;
    }

    ownerOf(terminal: Terminal | undefined): Session | undefined { return this.associationFor(terminal)?.session; }

    forSession(session: Session): TerminalAssociation<Session, Terminal> | undefined {
        for (const kind of ['explicit', 'native'] as const) {
            for (const association of this.associations.values()) {
                if (association.session === session && association.kind === kind && this.isCurrent(association)) {
                    return association;
                }
            }
        }
        return undefined;
    }

    isCurrent(association: TerminalAssociation<Session, Terminal>): boolean {
        return this.associationFor(association.terminal) === association;
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
        for (const previous of this.associations.values()) {
            if (previous.kind === 'explicit' && previous.session === session && previous.terminal !== terminal) {
                this.remove(previous.terminal);
            }
        }
        this.set(terminal, session, 'explicit');
        return true;
    }

    attachNative(terminal: Terminal, session: Session): boolean {
        if (!this.isLive(terminal) || !this.isConnected(session)
            || this.associationFor(terminal)?.kind === 'explicit') { return false; }
        this.set(terminal, session, 'native');
        return true;
    }

    releaseSession(session: Session): void {
        for (const association of this.associations.values()) {
            if (association.session === session) { this.remove(association.terminal); }
        }
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
        this.associations.set(terminal, { terminal, session, kind });
        this.changed(terminal);
    }

    private remove(terminal: Terminal): void {
        this.associations.delete(terminal);
        this.changed(terminal);
    }

    private changed(terminal: Terminal): void {
        this.revisions.set(terminal, (this.revisions.get(terminal) ?? 0) + 1);
        for (const listener of this.listeners) { listener(terminal); }
    }
}
