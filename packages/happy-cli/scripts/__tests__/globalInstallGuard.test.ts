import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const GUARD_SCRIPT = join(__dirname, '..', 'globalInstallGuard.cjs');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decideGlobalInstall } = require(GUARD_SCRIPT);

const liveState = {
    pid: 74338,
    state: 'running',
    trackedSessions: [
        { pid: 1, happySessionId: 'a' },
        { pid: 2, happySessionId: 'b' },
    ],
};

describe('decideGlobalInstall', () => {
    // A global install replaces the bundle every running daemon watches, so the
    // daemon hands itself over and every session it tracks loses its daemon.
    // That is what cost six hours on 2026-08-23 and again on 2026-08-25.
    it('blocks when a live daemon is tracking sessions', () => {
        const decision = decideGlobalInstall({ state: liveState, isPidAlive: () => true, override: undefined });

        expect(decision.blocked).toBe(true);
        expect(decision.sessionCount).toBe(2);
        expect(decision.pid).toBe(74338);
    });

    it('allows when the override is set', () => {
        const decision = decideGlobalInstall({ state: liveState, isPidAlive: () => true, override: '1' });

        expect(decision.blocked).toBe(false);
        expect(decision.overridden).toBe(true);
    });

    // Nothing to protect: no daemon means no sessions to yank.
    it('allows when there is no daemon state at all', () => {
        expect(decideGlobalInstall({ state: null, isPidAlive: () => true, override: undefined }).blocked).toBe(false);
    });

    it('allows when the recorded daemon is no longer alive', () => {
        const decision = decideGlobalInstall({ state: liveState, isPidAlive: () => false, override: undefined });

        expect(decision.blocked).toBe(false);
    });

    // A daemon with nothing to lose is the normal solo-dev case; blocking it
    // would make the guard noise that people learn to override reflexively.
    it('allows when a live daemon tracks no sessions', () => {
        const decision = decideGlobalInstall({
            state: { ...liveState, trackedSessions: [] },
            isPidAlive: () => true,
            override: undefined,
        });

        expect(decision.blocked).toBe(false);
    });

    it('allows when the state file records no pid to check', () => {
        const decision = decideGlobalInstall({
            state: { state: 'running', trackedSessions: [{ pid: 1 }] },
            isPidAlive: () => true,
            override: undefined,
        });

        expect(decision.blocked).toBe(false);
    });

    it('treats an empty override string as not set', () => {
        const decision = decideGlobalInstall({ state: liveState, isPidAlive: () => true, override: '' });

        expect(decision.blocked).toBe(true);
    });
});
