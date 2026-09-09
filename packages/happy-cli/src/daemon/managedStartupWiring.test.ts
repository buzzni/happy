import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Ordering guarantees inside `startDaemon` that a unit test on the module
 * cannot reach: the daemon takes ~40 dependencies and starting it for real
 * would open sockets and spawn processes.
 *
 * These assert the source order that the security argument depends on. They
 * are deliberately narrow — each one names a window that was, or would be, a
 * live bypass.
 */
const run = readFileSync(join(__dirname, 'run.ts'), 'utf8');

function indexOf(needle: string): number {
    const at = run.indexOf(needle);
    expect(at, `expected to find ${needle} in run.ts`).toBeGreaterThan(-1);
    return at;
}

describe('managed admission happens before anything can accept work', () => {
    it('resolves the runtime identity before the control server starts', () => {
        // The loopback control server exposes /spawn-session. Deciding managed
        // mode after it is listening leaves a window where an unsigned spawn is
        // reachable on a runtime that must never serve one.
        expect(indexOf('const managedIdentity = resolveManagedRuntimeIdentity()'))
            .toBeLessThan(indexOf('await startDaemonControlServer({'));
    });

    it('resolves the runtime identity before RPC handlers are registered', () => {
        expect(indexOf('const managedIdentity = resolveManagedRuntimeIdentity()'))
            .toBeLessThan(indexOf('apiMachine.setRPCHandlers({'));
    });

    it('installs the managed surface before setRPCHandlers applies it', () => {
        expect(indexOf('apiMachine.setManagedRuntime(managedHandlers)'))
            .toBeLessThan(indexOf('apiMachine.setRPCHandlers({'));
    });

    it('refuses to start when a marker exists but is not trusted', () => {
        expect(run).toContain("if (managedIdentity.status === 'refused')");
        expect(run).toContain('refusing to start');
    });

    it('refuses to start when the writer lock cannot be taken', () => {
        expect(run).toContain('writer lock unavailable');
    });

    it('passes the managed flag to the control server', () => {
        expect(run).toContain("managedRuntime: managedIdentity.status === 'active'");
    });
});

describe('managed state is declared before it is used', () => {
    it('declares the writer lock handle before any reference to it', () => {
        // A `let` referenced above its declaration throws at runtime — and this
        // path runs on every daemon start, BYOS included.
        const declaration = indexOf('let releaseManagedWriterLock:');
        const references = [...run.matchAll(/releaseManagedWriterLock/g)].map((m) => m.index ?? -1);
        for (const reference of references) {
            expect(reference).toBeGreaterThanOrEqual(declaration);
        }
    });

    it('declares the lock-held flag before any reference to it', () => {
        const declaration = indexOf('let managedWriterLockHeld =');
        const references = [...run.matchAll(/managedWriterLockHeld/g)].map((m) => m.index ?? -1);
        for (const reference of references) {
            expect(reference).toBeGreaterThanOrEqual(declaration);
        }
    });

    it('declares the watchdog handle before any reference to it', () => {
        const declaration = indexOf('let managedLeaseWatchdog:');
        const references = [...run.matchAll(/managedLeaseWatchdog/g)].map((m) => m.index ?? -1);
        for (const reference of references) {
            expect(reference).toBeGreaterThanOrEqual(declaration);
        }
    });
});

describe('managed teardown releases what it took', () => {
    it('runs on both exits, not only the self-update path', () => {
        const calls = [...run.matchAll(/await teardownManagedRuntime\(\)/g)];
        // One exit is the self-update replacement, the other is
        // cleanupAndShutdown. Wiring only the first leaves a normal shutdown
        // holding the writer lock.
        expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    it('precedes every daemon lock release', () => {
        const teardowns = [...run.matchAll(/await teardownManagedRuntime\(\)/g)].map((m) => m.index ?? -1);
        const daemonLocks = [...run.matchAll(/await releaseDaemonLock\(daemonLockHandle\)/g)].map((m) => m.index ?? -1);
        for (const lock of daemonLocks) {
            expect(teardowns.some((t) => t < lock && lock - t < 200)).toBe(true);
        }
    });

    it('closes writes before releasing the lock and waits for the in-flight tick', () => {
        const body = run.slice(indexOf('const teardownManagedRuntime'), indexOf('const teardownManagedRuntime') + 1600);
        const closed = body.indexOf('managedWriterLockHeld = false');
        const awaited = body.indexOf('await managedWatchdogTick');
        const released = body.indexOf('await releaseManagedWriterLock()');
        expect(closed).toBeGreaterThan(-1);
        expect(awaited).toBeGreaterThan(closed);
        // A resumed tick or RPC must be refused by the store, not allowed to
        // write into a directory another daemon may already own.
        expect(released).toBeGreaterThan(awaited);
    });

    it('says what it could not fence instead of implying a clean stop', () => {
        expect(run).toContain('running children are not fenced');
    });

    it('does nothing at all on a BYOS daemon', () => {
        const body = run.slice(indexOf('const teardownManagedRuntime'), indexOf('const teardownManagedRuntime') + 400);
        expect(body).toContain("if (managedIdentity.status !== 'active') return;");
    });
});

describe('BYOS daemons are untouched', () => {
    it('guards every managed side effect behind an active identity', () => {
        // Call sites, not imports — an import legitimately precedes the guard.
        for (const guarded of [
            'apiMachine.setManagedRuntime(',
            'await acquireManagedWriterLock(',
            'createManagedReceiptStore(',
        ]) {
            const at = indexOf(guarded);
            const preceding = run.slice(0, at);
            const lastGuard = preceding.lastIndexOf("managedIdentity.status === 'active'");
            expect(lastGuard, `${guarded} must sit inside an active-identity guard`)
                .toBeGreaterThan(-1);
        }
    });
});

/**
 * Entry points that never pass through `RpcHandlerManager`, and so are not
 * covered by its dispatch allowlist. Each one is closed at its own door.
 */
const controlServer = readFileSync(join(__dirname, 'controlServer.ts'), 'utf8');
const apiMachine = readFileSync(join(__dirname, '..', 'api', 'apiMachine.ts'), 'utf8');

describe('transports outside the RPC dispatch gate', () => {
    it('closes every control-server path except the lifecycle reports', () => {
        const line = controlServer.slice(
            controlServer.indexOf('const MANAGED_REPORT_PATHS'),
            controlServer.indexOf('\n', controlServer.indexOf('const MANAGED_REPORT_PATHS')),
        );
        // Shell execution, spawn, stop and the proxies must not be reachable.
        for (const path of ['/start-server', '/spawn-session', '/stop-session', '/proxy-http', '/browser/request']) {
            expect(line).not.toContain(path);
        }
        // `/stop` would kill the lease watchdog; that is not report authority.
        expect(line).not.toContain('/stop');
    });

    it('does not accept a managed report on the shared bearer alone', () => {
        // The loopback secret is readable by the agent's own tools, so it
        // identifies the host, not the launch that is reporting.
        expect(controlServer).toContain('verifyManagedReport');
        expect(controlServer).toContain("reason: 'no-launch-verifier'");
        expect(controlServer).toContain('MANAGED_LAUNCH_SCOPE_REQUIRED');
    });

    it('gates the control server before the bearer check, not after', () => {
        const gate = controlServer.indexOf('MANAGED_REPORT_PATHS.has');
        const bearer = controlServer.indexOf('`Bearer ${controlSecret}`');
        expect(gate).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(bearer);
    });

    it('does not attach the terminal WebSocket on a managed runtime', () => {
        expect(controlServer).toContain('managedRuntime ? null : attachTerminalWsRoute');
    });

    it('does not attach the socket forwarders on a managed runtime', () => {
        for (const listener of ['proxy-ws-open', 'terminal-open-fwd', 'terminal-frame-fwd']) {
            const at = apiMachine.indexOf(`this.socket.on('${listener}'`);
            expect(at, listener).toBeGreaterThan(-1);
            expect(apiMachine.slice(Math.max(0, at - 240), at)).toContain('if (!this.managedHandlers)');
        }
    });

    it('keeps all of it inert on a BYOS machine', () => {
        // Every gate above keys off `managedRuntime` / `managedHandlers`, both
        // of which stay false/null when no provisioning marker exists.
        expect(controlServer).toContain('managedRuntime = false');
        expect(apiMachine).toContain('private managedHandlers: ManagedRpcHandlers | null = null;');
    });
});
