import { describe, expect, it } from 'vitest';

import { hasLiveDaemonChild, shareInFlight } from './resumeGuards';

// 2026-08-05 incident: two resume-happy-session RPCs 6.7s apart spawned two CLI
// processes for the same happy session. Both attached, both idle, both were
// empty-reaped 15 minutes later. A resume must reuse a live child and share an
// in-flight spawn instead of double-spawning.
describe('hasLiveDaemonChild', () => {
    it('detects a live child already attached to the session', () => {
        expect(hasLiveDaemonChild('session-1', [
            { happySessionId: 'session-other' },
            { happySessionId: 'session-1' },
        ])).toBe(true);
    });

    it('reports no live child when only other sessions are running', () => {
        expect(hasLiveDaemonChild('session-1', [
            { happySessionId: 'session-other' },
            { happySessionId: undefined },
        ])).toBe(false);
    });
});

describe('shareInFlight', () => {
    it('returns the same promise for concurrent calls with the same key', async () => {
        const inflight = new Map<string, Promise<string>>();
        let spawns = 0;
        let release!: (value: string) => void;
        const factory = () => {
            spawns += 1;
            return new Promise<string>((resolve) => { release = resolve; });
        };

        const first = shareInFlight(inflight, 'session-1', factory);
        const second = shareInFlight(inflight, 'session-1', factory);
        release('spawned');

        expect(await first).toBe('spawned');
        expect(await second).toBe('spawned');
        expect(spawns).toBe(1);
    });

    it('runs the factory again once the previous call settled', async () => {
        const inflight = new Map<string, Promise<string>>();
        let spawns = 0;
        const factory = async () => {
            spawns += 1;
            return `spawn-${spawns}`;
        };

        expect(await shareInFlight(inflight, 'session-1', factory)).toBe('spawn-1');
        expect(await shareInFlight(inflight, 'session-1', factory)).toBe('spawn-2');
        expect(inflight.size).toBe(0);
    });

    it('clears the in-flight slot when the factory rejects', async () => {
        const inflight = new Map<string, Promise<string>>();
        await expect(shareInFlight(inflight, 'session-1', async () => {
            throw new Error('spawn failed');
        })).rejects.toThrow('spawn failed');

        expect(inflight.size).toBe(0);
        expect(await shareInFlight(inflight, 'session-1', async () => 'recovered')).toBe('recovered');
    });

    it('keeps different keys independent', async () => {
        const inflight = new Map<string, Promise<string>>();
        const [a, b] = await Promise.all([
            shareInFlight(inflight, 'session-a', async () => 'a'),
            shareInFlight(inflight, 'session-b', async () => 'b'),
        ]);
        expect(a).toBe('a');
        expect(b).toBe('b');
    });
});
