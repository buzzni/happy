import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

import {
    probeProcessGroup,
    requestProcessGroupStop,
    signalProcessGroup,
    summarizeFencingEvidence,
    type ProcessGroupDeps,
} from './managedProcessGroup';

function deps(overrides: Partial<ProcessGroupDeps> = {}): ProcessGroupDeps {
    let clock = 0;
    return {
        kill: () => {},
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
        ...overrides,
    };
}

function errno(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(code), { code });
}

describe('signalProcessGroup', () => {
    it('targets the whole group, not the leader', () => {
        const calls: Array<[number, string | number]> = [];
        signalProcessGroup(4242, 'SIGTERM', deps({ kill: (t, s) => { calls.push([t, s]); } }));
        // A positive pid would leave the agent's own children writing.
        expect(calls).toEqual([[-4242, 'SIGTERM']]);
    });

    it('refuses a pgid that could hit init or come from a corrupt receipt', () => {
        for (const pgid of [0, 1, -5, 1.5, Number.NaN]) {
            expect(signalProcessGroup(pgid, 'SIGTERM', deps()))
                .toEqual({ kind: 'indeterminate', detail: 'invalid pgid' });
        }
    });

    it('reads EPERM as alive-but-foreign, never as gone', () => {
        expect(signalProcessGroup(10, 0, deps({ kill: () => { throw errno('EPERM'); } })))
            .toEqual({ kind: 'not-permitted' });
    });

    it('keeps an uninterpretable errno as indeterminate', () => {
        expect(signalProcessGroup(10, 0, deps({ kill: () => { throw errno('EINVAL'); } })))
            .toEqual({ kind: 'indeterminate', detail: 'EINVAL' });
    });
});

describe('probeProcessGroup', () => {
    it('maps ESRCH to no-local-trace rather than "stopped"', () => {
        expect(probeProcessGroup(10, deps({ kill: () => { throw errno('ESRCH'); } })))
            .toEqual({ kind: 'no-local-trace' });
    });

    it('maps EPERM to alive-foreign', () => {
        expect(probeProcessGroup(10, deps({ kill: () => { throw errno('EPERM'); } })))
            .toEqual({ kind: 'alive-foreign' });
    });
});

describe('requestProcessGroupStop — ownership', () => {
    it('sends no terminating signal to a group it cannot prove it owns', async () => {
        const signals: Array<string | number> = [];
        const result = await requestProcessGroupStop({
            pgid: 4242,
            graceMs: 100,
            ownership: { kind: 'unverified' },
            deps: deps({ kill: (_target, signal) => { signals.push(signal); } }),
        });
        // After a restart the stored pgid may belong to an unrelated process:
        // the number alone is not ownership. Signal 0 only asks whether
        // something is there and cannot terminate it, so observing is allowed.
        expect(signals.filter((signal) => signal !== 0)).toEqual([]);
        expect(result.signalled).toBe(false);
        expect(result.deferredTo).toBe('privileged-backend');
    });

    it('still reports observation when it declines to signal', async () => {
        const result = await requestProcessGroupStop({
            pgid: 4242,
            graceMs: 100,
            ownership: { kind: 'unverified' },
            deps: deps({ kill: () => { throw errno('EPERM'); } }),
        });
        expect(result.evidence).toEqual({ kind: 'alive-foreign' });
    });

    it('signals when the group is a child this process is still tracking', async () => {
        const calls: Array<[number, string | number]> = [];
        let alive = true;
        await requestProcessGroupStop({
            pgid: 4242,
            graceMs: 1_000,
            ownership: { kind: 'live-tracked-child' },
            deps: deps({
                kill: (target, signal) => {
                    calls.push([target, signal]);
                    if (signal === 0 && !alive) throw errno('ESRCH');
                    if (signal === 'SIGTERM') alive = false;
                },
            }),
        });
        expect(calls[0]).toEqual([-4242, 'SIGTERM']);
    });

    it('escalates to SIGKILL and reports a failing SIGKILL instead of dropping it', async () => {
        const signals: Array<string | number> = [];
        const result = await requestProcessGroupStop({
            pgid: 4242,
            graceMs: 10,
            pollMs: 5,
            ownership: { kind: 'live-tracked-child' },
            deps: deps({
                kill: (_target, signal) => {
                    signals.push(signal);
                    if (signal === 'SIGKILL') throw errno('EPERM');
                },
            }),
        });
        expect(signals).toContain('SIGKILL');
        expect(result.escalated).toBe(true);
        // Losing this would report a clean stop for a group we could not kill.
        expect(result.killOutcome).toEqual({ kind: 'not-permitted' });
        expect(result.evidence.kind).not.toBe('no-local-trace');
    });

    it('rejects a non-finite grace or poll instead of looping forever', async () => {
        for (const bad of [{ graceMs: Number.NaN }, { graceMs: -1 }, { pollMs: 0 }, { pollMs: Number.POSITIVE_INFINITY }]) {
            const result = await requestProcessGroupStop({
                pgid: 4242,
                graceMs: 10,
                pollMs: 5,
                ownership: { kind: 'live-tracked-child' },
                deps: deps(),
                ...bad,
            });
            expect(result.evidence.kind).toBe('indeterminate');
            expect(result.signalled).toBe(false);
        }
    });
});

describe('summarizeFencingEvidence', () => {
    it('never calls local quiet sufficient on its own', () => {
        const summary = summarizeFencingEvidence([{ kind: 'no-local-trace' }]);
        expect(summary.allClear).toBe(true);
        // A setsid child leaves the group and is invisible to every local check.
        expect(summary.requiresExternalProof).toBe(true);
    });

    it('reports every non-clear observation', () => {
        const summary = summarizeFencingEvidence([
            { kind: 'alive' },
            { kind: 'alive-foreign' },
            { kind: 'indeterminate', detail: 'EIO' },
            { kind: 'no-local-trace' },
        ]);
        expect(summary.allClear).toBe(false);
        expect(summary.reasons).toEqual(['group-alive', 'group-alive-foreign', 'indeterminate:EIO']);
    });
});

describe('real detached child (fixture only)', () => {
    it('sees a detached child group as alive and as gone after it exits', async () => {
        // A fixture process of our own — never an existing CLI session or any
        // other process on this machine.
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
            detached: true,
            stdio: 'ignore',
        });
        try {
            expect(child.pid).toBeGreaterThan(0);
            expect(probeProcessGroup(child.pid!).kind).toBe('alive');

            const result = await requestProcessGroupStop({
                pgid: child.pid!,
                graceMs: 3_000,
                pollMs: 50,
                ownership: { kind: 'live-tracked-child' },
            });
            expect(result.signalled).toBe(true);
            expect(result.evidence.kind).toBe('no-local-trace');
        } finally {
            try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
        }
    });
});
