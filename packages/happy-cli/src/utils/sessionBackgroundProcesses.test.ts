// aplus-dev-studio-desktop#2111 — the session-owned background process records and the
// `clean-background-processes` RPC. Real processes where the platform allows it; an injected
// `kill` only where the case (a recycled pid) cannot be produced on demand.

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
    CLEAN_BACKGROUND_PROCESSES_METHOD,
    createSessionBackgroundProcesses,
    createTurnSequence,
    registerCleanBackgroundProcessesHandler,
    type SessionBackgroundProcesses,
} from './sessionBackgroundProcesses';

const posix = process.platform !== 'win32';
const spawned: ChildProcess[] = [];
const groups: number[] = [];

function start(command: string, detached = false): ChildProcess {
    const child = spawn('bash', ['-c', command], { detached, stdio: 'ignore' });
    spawned.push(child);
    if (detached && child.pid) groups.push(child.pid);
    return child;
}

function alive(target: number): boolean {
    try {
        process.kill(target, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

/** The interrupt as the runtime sees it: the abort marks turn 1, then the RPC cleans. */
function abortAndClean(registry: SessionBackgroundProcesses, sessionId: string) {
    registry.markTurnAborted(sessionId, 1);
    return registry.clean(sessionId);
}

function exited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

afterEach(() => {
    for (const child of spawned.splice(0)) if (!exited(child)) child.kill('SIGKILL');
    for (const group of groups.splice(0)) {
        try { process.kill(-group, 'SIGKILL'); } catch { /* already gone */ }
    }
});

/** A live child as Node sees it before the exit event: unreaped, so its pid is still ours. */
function liveFakeChild(pid: number): ChildProcess & { finish: () => void } {
    const child = new EventEmitter() as unknown as ChildProcess & { finish: () => void };
    Object.assign(child, { pid, exitCode: null, signalCode: null });
    child.finish = () => {
        Object.assign(child, { exitCode: 0 });
        child.emit('exit', 0, null);
    };
    return child;
}

describe.runIf(posix)('session background processes (real processes)', () => {
    it('stops a recorded process that is still running and reports it', async () => {
        const registry = createSessionBackgroundProcesses({ graceMs: 2_000 });
        const child = start('sleep 30');
        registry.record({ sessionId: 's1', child, command: 'sleep 30', ownProcessGroup: false, turnId: 1 });

        const result = await abortAndClean(registry, 's1');

        expect(result).toMatchObject({ stopped: 1, failed: 0, items: [{ pid: child.pid, command: 'sleep 30', result: 'stopped' }] });
        await until(() => exited(child));
        expect(await abortAndClean(registry, 's1')).toEqual({ stopped: 0, failed: 0, items: [] });
    });

    it('escalates to SIGKILL when the recorded process ignores SIGTERM', async () => {
        const registry = createSessionBackgroundProcesses({ graceMs: 200 });
        const child = start('trap "" TERM; while :; do sleep 0.05; done');
        // Let bash install the trap before the signal arrives.
        await new Promise((resolve) => setTimeout(resolve, 200));
        registry.record({ sessionId: 's1', child, command: 'stubborn', ownProcessGroup: false, turnId: 1 });

        const result = await abortAndClean(registry, 's1');

        expect(result.stopped).toBe(1);
        expect(child.signalCode).toBe('SIGKILL');
    });

    it('stops the whole group of a process spawned as its own group leader, including what it left behind', async () => {
        const registry = createSessionBackgroundProcesses({ graceMs: 2_000 });
        // The root exits at once; the subshell's sleep keeps running in the group the root led.
        const child = start('(sleep 30 &) ; exit 0', true);
        const groupId = child.pid!;
        registry.record({ sessionId: 's1', child, command: 'leave a server running', ownProcessGroup: true, turnId: 1 });
        await until(() => exited(child));
        expect(alive(-groupId)).toBe(true);

        const result = await abortAndClean(registry, 's1');

        expect(result).toMatchObject({ stopped: 1, failed: 0 });
        await until(() => !alive(-groupId));
    });

    it('forgets a process that exits on its own instead of signalling its pid later', async () => {
        const registry = createSessionBackgroundProcesses();
        const child = start('exit 0');
        registry.record({ sessionId: 's1', child, command: 'exit 0', ownProcessGroup: false, turnId: 1 });
        await until(() => exited(child));

        expect(await abortAndClean(registry, 's1')).toEqual({ stopped: 0, failed: 0, items: [] });
    });

    it('only signals the recorded pid when the process shares the session process group', async () => {
        const registry = createSessionBackgroundProcesses({ graceMs: 2_000 });
        const sibling = start('sleep 30');
        const child = start('sleep 30');
        registry.record({ sessionId: 's1', child, command: 'sleep 30', ownProcessGroup: false, turnId: 1 });

        await abortAndClean(registry, 's1');

        await until(() => exited(child));
        expect(exited(sibling)).toBe(false);
        expect(alive(process.pid)).toBe(true);
    });

    it('never touches another session’s records', async () => {
        const registry = createSessionBackgroundProcesses({ graceMs: 2_000 });
        const mine = start('sleep 30');
        const theirs = start('sleep 30');
        registry.record({ sessionId: 'mine', child: mine, command: 'sleep 30', ownProcessGroup: false, turnId: 1 });
        registry.record({ sessionId: 'theirs', child: theirs, command: 'sleep 30', ownProcessGroup: false, turnId: 1 });

        const result = await abortAndClean(registry, 'mine');

        expect(result.stopped).toBe(1);
        await until(() => exited(mine));
        expect(exited(theirs)).toBe(false);
        expect((await abortAndClean(registry, 'theirs')).stopped).toBe(1);
    });

    it('answers the session RPC for its own session only, whatever the params say', async () => {
        const registry = createSessionBackgroundProcesses({ graceMs: 2_000 });
        const mine = start('sleep 30');
        const theirs = start('sleep 30');
        registry.record({ sessionId: 'mine', child: mine, command: 'sleep 30', ownProcessGroup: false, turnId: 1 });
        registry.record({ sessionId: 'theirs', child: theirs, command: 'sleep 30', ownProcessGroup: false, turnId: 1 });
        const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
        registerCleanBackgroundProcessesHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, 'mine', registry);
        registry.markTurnAborted('mine', 1);
        registry.markTurnAborted('theirs', 1);

        const response = await handlers.get(CLEAN_BACKGROUND_PROCESSES_METHOD)!({ sessionId: 'theirs' });

        expect(response).toMatchObject({ stopped: 1, failed: 0 });
        await until(() => exited(mine));
        expect(exited(theirs)).toBe(false);
    });
});

// The user's decision (#2111 review): only processes the interrupted turn started.
describe.runIf(posix)('session background processes (turn scope)', () => {
    it('leaves a server an earlier turn started running when a later turn is interrupted', async () => {
        const registry = createSessionBackgroundProcesses({ graceMs: 2_000 });
        const devServer = start('sleep 30');
        const aborted = start('sleep 30');
        registry.record({ sessionId: 's1', child: devServer, command: 'npm run dev', ownProcessGroup: false, turnId: 1 });
        registry.record({ sessionId: 's1', child: aborted, command: 'npm test', ownProcessGroup: false, turnId: 2 });

        registry.markTurnAborted('s1', 2);
        const result = await registry.clean('s1');

        expect(result).toMatchObject({ stopped: 1, failed: 0, items: [{ command: 'npm test', result: 'stopped' }] });
        await until(() => exited(aborted));
        expect(exited(devServer)).toBe(false);
    });

    it('leaves what the next turn started after the interrupt alone, even when the clean-up arrives late', async () => {
        const registry = createSessionBackgroundProcesses({ graceMs: 2_000 });
        const aborted = start('sleep 30');
        registry.record({ sessionId: 's1', child: aborted, command: 'build', ownProcessGroup: false, turnId: 1 });
        registry.markTurnAborted('s1', 1);
        const nextTurn = start('sleep 30');
        registry.record({ sessionId: 's1', child: nextTurn, command: 'next', ownProcessGroup: false, turnId: 2 });

        const result = await registry.clean('s1');

        expect(result.stopped).toBe(1);
        await until(() => exited(aborted));
        expect(exited(nextTurn)).toBe(false);
    });

    it('cleans nothing when no turn was interrupted, and nothing outside a turn', async () => {
        const registry = createSessionBackgroundProcesses({ graceMs: 2_000 });
        const inTurn = start('sleep 30');
        const outsideTurn = start('sleep 30');
        registry.record({ sessionId: 's1', child: inTurn, command: 'job', ownProcessGroup: false, turnId: 1 });
        registry.record({ sessionId: 's1', child: outsideTurn, command: 'job', ownProcessGroup: false, turnId: null });

        expect(await registry.clean('s1')).toEqual({ stopped: 0, failed: 0, items: [] });
        registry.markTurnAborted('s1', null);
        expect(await registry.clean('s1')).toEqual({ stopped: 0, failed: 0, items: [] });
        expect(exited(inTurn) || exited(outsideTurn)).toBe(false);
    });

    it('cleans an interrupted turn once: the mark is spent by the clean-up', async () => {
        const registry = createSessionBackgroundProcesses({ graceMs: 2_000 });
        registry.markTurnAborted('s1', 1);
        expect(await registry.clean('s1')).toEqual({ stopped: 0, failed: 0, items: [] });
        const later = start('sleep 30');
        registry.record({ sessionId: 's1', child: later, command: 'late', ownProcessGroup: false, turnId: 1 });

        expect(await registry.clean('s1')).toEqual({ stopped: 0, failed: 0, items: [] });
        expect(exited(later)).toBe(false);
    });

    it('forgets an interrupt that was never cleaned up after the TTL', async () => {
        let now = 1_000;
        const registry = createSessionBackgroundProcesses({ graceMs: 2_000, now: () => now, abortedTurnTtlMs: 600_000 });
        const child = start('sleep 30');
        registry.record({ sessionId: 's1', child, command: 'job', ownProcessGroup: false, turnId: 1 });
        registry.markTurnAborted('s1', 1);
        now += 600_001;

        expect(await registry.clean('s1')).toEqual({ stopped: 0, failed: 0, items: [] });
        expect(exited(child)).toBe(false);
    });
});

describe('turn sequence', () => {
    it('opens a new turn id on each idle-to-busy change and has none while idle', () => {
        const turns = createTurnSequence();
        expect(turns.current()).toBeNull();
        turns.observeThinking(true);
        expect(turns.current()).toBe(1);
        turns.observeThinking(true);
        expect(turns.current()).toBe(1);
        turns.observeThinking(false);
        expect(turns.current()).toBeNull();
        turns.observeThinking(true);
        expect(turns.current()).toBe(2);
    });
});

describe('session background processes (identity checks)', () => {
    it('refuses a group whose leader pid now belongs to another process (pid reuse)', async () => {
        const signals: Array<[number, NodeJS.Signals | 0]> = [];
        const missing = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        let reused = false;
        const registry = createSessionBackgroundProcesses({
            platform: 'darwin',
            kill: (target, signal) => {
                signals.push([target, signal]);
                if (target === 4242 && !reused) throw missing;
            },
        });
        const child = liveFakeChild(4242);
        registry.record({ sessionId: 's1', child, command: 'npm run dev', ownProcessGroup: true, turnId: 1 });
        // The leader exits while the server it started keeps the group alive: the record stays.
        child.finish();
        expect(registry.list('s1')).toHaveLength(1);
        // Later something unrelated holds pid 4242 — our group can no longer exist.
        reused = true;

        const result = await abortAndClean(registry, 's1');

        expect(result).toEqual({ stopped: 0, failed: 0, items: [{ pid: 4242, command: 'npm run dev', result: 'skipped', reason: 'pid-reused' }] });
        expect(signals.every(([, signal]) => signal === 0)).toBe(true);
        expect(registry.list('s1')).toEqual([]);
    });

    it('reports a group it cannot verify as failed and sends it nothing', async () => {
        const signals: Array<[number, NodeJS.Signals | 0]> = [];
        const denied = Object.assign(new Error('EPERM'), { code: 'EPERM' });
        const missing = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        const registry = createSessionBackgroundProcesses({
            platform: 'linux',
            kill: (target, signal) => {
                signals.push([target, signal]);
                throw target > 0 ? missing : denied;
            },
        });
        const child = liveFakeChild(5151);
        registry.record({ sessionId: 's1', child, command: 'server', ownProcessGroup: true, turnId: 1 });
        child.finish();

        const result = await abortAndClean(registry, 's1');

        expect(result).toMatchObject({ stopped: 0, failed: 1, items: [{ pid: 5151, result: 'failed', reason: 'unverifiable' }] });
        expect(signals.every(([, signal]) => signal === 0)).toBe(true);
        expect(registry.list('s1')).toHaveLength(1);
    });

    it('drops a group record once the group is gone after its leader exits', () => {
        const missing = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        const registry = createSessionBackgroundProcesses({ platform: 'linux', kill: () => { throw missing; } });
        const child = liveFakeChild(6161);
        registry.record({ sessionId: 's1', child, command: 'job', ownProcessGroup: true, turnId: 1 });

        child.finish();

        expect(registry.list('s1')).toEqual([]);
    });

    it('never records the session process itself or a child that never started', () => {
        const registry = createSessionBackgroundProcesses({ platform: 'linux', kill: () => {} });
        registry.record({ sessionId: 's1', child: liveFakeChild(process.pid), command: 'self', ownProcessGroup: true, turnId: 1 });
        registry.record({ sessionId: 's1', child: liveFakeChild(0), command: 'no pid', ownProcessGroup: false, turnId: 1 });

        expect(registry.list('s1')).toEqual([]);
    });

    it('treats a process group as the pid alone on Windows', () => {
        const registry = createSessionBackgroundProcesses({ platform: 'win32', kill: () => {} });
        registry.record({ sessionId: 's1', child: liveFakeChild(7171), command: 'job', ownProcessGroup: true, turnId: 1 });

        expect(registry.list('s1')[0]?.processGroupId).toBeNull();
    });
});
