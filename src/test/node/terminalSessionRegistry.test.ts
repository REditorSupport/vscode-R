import * as assert from 'assert';
import { TerminalSessionRegistry } from '../../terminalSessionRegistry';

interface Owner { id: string; connected: boolean }
interface Terminal { open: boolean }

suite('Terminal session registry', () => {
    let registry: TerminalSessionRegistry<Owner, Terminal>;
    let current: Map<string, Owner>;
    let first: Owner;
    let second: Owner;
    let terminal: Terminal;
    let other: Terminal;

    setup(() => {
        first = { id: 'first', connected: true };
        second = { id: 'second', connected: true };
        current = new Map([[first.id, first], [second.id, second]]);
        terminal = { open: true }; other = { open: true };
        registry = new TerminalSessionRegistry(owner => current.get(owner.id) === owner && owner.connected, target => target.open);
    });

    for (const end of ['disconnect', 'move', 'replace'] as const) {
        test(`native → explicit → ${end} never resurrects native ownership`, () => {
            assert.strictEqual(registry.attachNative(terminal, first), true);
            const native = registry.forSession(first);
            assert.ok(native);
            assert.strictEqual(registry.bindExplicit(terminal, second), true);
            assert.strictEqual(registry.isCurrent(native), false);
            assert.strictEqual(registry.ownerOf(terminal), second);
            if (end === 'move') { registry.bindExplicit(other, second); }
            else {
                if (end === 'replace') { current.set(second.id, { id: second.id, connected: true }); }
                else { second.connected = false; }
                registry.releaseSession(second);
            }
            assert.strictEqual(registry.ownerOf(terminal), undefined);
            assert.strictEqual(registry.forSession(first), undefined);
            assert.strictEqual(registry.attachNative(terminal, first), true, 'a fresh handshake establishes new ownership');
            assert.strictEqual(registry.ownerOf(terminal), first);
            assert.strictEqual(registry.isCurrent(native), false);
        });
    }

    test('native handshakes cannot replace a live explicit owner or become its hidden fallback', () => {
        registry.bindExplicit(terminal, first);
        assert.strictEqual(registry.attachNative(terminal, second), false);
        assert.strictEqual(registry.ownerOf(terminal), first);
        registry.releaseSession(first);
        assert.strictEqual(registry.ownerOf(terminal), undefined);
        assert.strictEqual(registry.forSession(second), undefined);
    });

    test('explicit binding replaces the session native terminal and is exclusive per session', () => {
        registry.attachNative(other, first);
        const native = registry.forSession(first);
        assert.ok(native);
        registry.bindExplicit(terminal, first);
        assert.strictEqual(registry.forSession(first)?.terminal, terminal);
        assert.strictEqual(registry.ownerOf(other), undefined);
        assert.strictEqual(registry.isCurrent(native), false);
        registry.bindExplicit(other, first);
        assert.strictEqual(registry.ownerOf(terminal), undefined);
        assert.strictEqual(registry.forSession(first)?.terminal, other);
        registry.bindExplicit(other, second);
        assert.strictEqual(registry.forSession(first), undefined);
    });

    test('closing a different explicit terminal cannot restore the session old native terminal', () => {
        registry.attachNative(terminal, first);
        registry.bindExplicit(other, first);
        registry.closeTerminal(other);
        assert.strictEqual(registry.forSession(first), undefined);
        assert.strictEqual(registry.ownerOf(terminal), undefined);
        assert.strictEqual(registry.attachNative(terminal, first), true, 'only a fresh attach may restore native routing');
        assert.strictEqual(registry.forSession(first)?.terminal, terminal);
    });

    test('native attach cannot give an explicitly bound session a second terminal', () => {
        registry.bindExplicit(terminal, first);
        registry.attachNative(other, second);
        const explicit = registry.forSession(first);
        const native = registry.forSession(second);
        assert.ok(explicit && native);
        assert.strictEqual(registry.attachNative(other, first), false);
        assert.strictEqual(registry.forSession(first), explicit);
        assert.strictEqual(registry.forSession(second), native);
        assert.strictEqual(registry.ownerOf(other), second);
    });

    test('moving native ownership invalidates the previous terminal and queued association', () => {
        registry.attachNative(terminal, first);
        const old = registry.forSession(first);
        assert.ok(old);
        registry.attachNative(other, first);
        assert.strictEqual(registry.ownerOf(terminal), undefined);
        assert.strictEqual(registry.forSession(first)?.terminal, other);
        assert.strictEqual(registry.isCurrent(old), false);
        registry.closeTerminal(terminal);
        assert.strictEqual(registry.forSession(first)?.terminal, other, 'closing the former terminal must not remove the new target');
    });

    test('replacing both endpoints updates reverse ownership before notifying subscribers', () => {
        registry.attachNative(terminal, first);
        registry.bindExplicit(other, second);
        const oldNative = registry.snapshot(terminal);
        const oldExplicit = registry.snapshot(other);
        const changed: Terminal[] = [];
        registry.onDidChange(target => {
            changed.push(target);
            assert.strictEqual(registry.ownerOf(terminal), undefined);
            assert.strictEqual(registry.ownerOf(other), first);
            assert.strictEqual(registry.forSession(first)?.terminal, other);
            assert.strictEqual(registry.forSession(second), undefined);
            assert.strictEqual(oldNative(), false);
            assert.strictEqual(oldExplicit(), false);
        });
        registry.bindExplicit(other, first);
        assert.deepStrictEqual(new Set(changed), new Set([terminal, other]));
    });

    test('rebinding away and back invalidates previously queued input', () => {
        registry.bindExplicit(terminal, first);
        const queued = registry.forSession(first);
        assert.ok(queued);
        registry.bindExplicit(terminal, second);
        registry.bindExplicit(terminal, first);
        assert.strictEqual(registry.isCurrent(queued), false);
        assert.strictEqual(registry.ownerOf(terminal), first);
    });

    test('repeating the same binding preserves its existing association', () => {
        registry.bindExplicit(terminal, first);
        const queued = registry.forSession(first);
        assert.ok(queued);
        registry.bindExplicit(terminal, first);
        assert.strictEqual(registry.isCurrent(queued), true);
    });

    test('late cleanup from an old connection cannot delete its replacement', () => {
        registry.bindExplicit(terminal, first);
        const old = registry.forSession(first);
        assert.ok(old);
        const replacement = { id: first.id, connected: true };
        current.set(first.id, replacement);
        assert.strictEqual(registry.ownerOf(terminal), undefined);
        registry.bindExplicit(terminal, replacement);
        registry.releaseSession(first);
        assert.strictEqual(registry.ownerOf(terminal), replacement);
        assert.strictEqual(registry.isCurrent(old), false);
    });

    for (const invalid of ['closed', 'disconnected', 'removed'] as const) {
        test(`${invalid} associations authorize neither execution nor readiness`, () => {
            registry.bindExplicit(terminal, first);
            const queued = registry.forSession(first);
            assert.ok(queued);
            if (invalid === 'closed') { registry.closeTerminal(terminal); }
            else if (invalid === 'disconnected') { first.connected = false; }
            else { current.delete(first.id); }
            assert.strictEqual(registry.ownerOf(terminal), undefined);
            assert.strictEqual(registry.forSession(first), undefined);
            assert.strictEqual(registry.isCurrent(queued), false);
            assert.strictEqual(registry.bindExplicit(terminal, first), false);
        });
    }

    test('a native lookup snapshot detects intervening ownership changes, including removal', () => {
        const pending = registry.snapshot(terminal);
        registry.bindExplicit(terminal, first);
        registry.releaseSession(first);
        assert.strictEqual(pending(), false);
        const fresh = registry.snapshot(terminal);
        registry.bindExplicit(other, second);
        assert.strictEqual(fresh(), true, 'an unrelated terminal does not invalidate the lookup');
        registry.closeTerminal(terminal);
        assert.strictEqual(fresh(), false);
        assert.strictEqual(registry.attachNative(terminal, first), false);
    });

    test('change subscribers observe the same owner as execution and stop after disposal', () => {
        const observed: Array<Owner | undefined> = [];
        const subscription = registry.onDidChange(target => observed.push(registry.ownerOf(target)));
        registry.attachNative(terminal, first);
        registry.bindExplicit(terminal, second);
        registry.releaseSession(second);
        assert.deepStrictEqual(observed, [first, second, undefined]);
        subscription.dispose();
        registry.attachNative(terminal, first);
        assert.strictEqual(observed.length, 3);
    });
});
