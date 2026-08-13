import { describe, expect, it } from 'vitest';

import {
    decideAutomationResumePreflight,
    hasLiveDaemonChild,
    resolveAutomationDirectoryMatch,
    shareInFlight,
} from './resumeGuards';

// 2026-08-05 incident: two resume-happy-session RPCs 6.7s apart spawned two CLI
// processes for the same happy session. Both attached, both idle, both were
// empty-reaped 15 minutes later. A resume must reuse a live child and share an
// in-flight spawn instead of double-spawning.
describe('hasLiveDaemonChild', () => {
    const alive = () => true;

    it('detects a live child already attached to the session', () => {
        expect(hasLiveDaemonChild('session-1', [
            { happySessionId: 'session-other', pid: 10 },
            { happySessionId: 'session-1', pid: 11 },
        ], alive)).toBe(true);
    });

    it('reports no live child when only other sessions are running', () => {
        expect(hasLiveDaemonChild('session-1', [
            { happySessionId: 'session-other', pid: 10 },
            { happySessionId: undefined, pid: 11 },
        ], alive)).toBe(false);
    });

    // Adopted/external sessions have no childProcess handle, so no exit event
    // removes them — only the periodic health check prunes dead PIDs. Trusting
    // the map alone would answer "already running" for a session whose process
    // died seconds ago, and the resume would spawn nothing at all.
    it('ignores a tracked entry whose process is already dead', () => {
        expect(hasLiveDaemonChild('session-1', [
            { happySessionId: 'session-1', pid: 99 },
        ], (pid) => pid !== 99)).toBe(false);
    });

    it('still finds a live entry when a dead duplicate is listed first', () => {
        expect(hasLiveDaemonChild('session-1', [
            { happySessionId: 'session-1', pid: 99 },
            { happySessionId: 'session-1', pid: 100 },
        ], (pid) => pid !== 99)).toBe(true);
    });
});

describe('decideAutomationResumePreflight', () => {
    it('falls back immediately when a live target belongs to another directory', () => {
        expect(decideAutomationResumePreflight({
            resumeInFlight: false,
            live: true,
            sameDirectory: false,
        })).toBe('fallback');
    });

    it('keeps a same-directory or unresolved live target busy to protect the writer', () => {
        expect(decideAutomationResumePreflight({
            resumeInFlight: false,
            live: true,
            sameDirectory: true,
        })).toBe('busy');
        expect(decideAutomationResumePreflight({
            resumeInFlight: false,
            live: true,
            sameDirectory: null,
        })).toBe('busy');
    });

    it('keeps an in-flight resume busy and otherwise proceeds', () => {
        expect(decideAutomationResumePreflight({
            resumeInFlight: true,
            live: false,
            sameDirectory: false,
        })).toBe('busy');
        expect(decideAutomationResumePreflight({
            resumeInFlight: false,
            live: false,
            sameDirectory: false,
        })).toBe('resume');
    });
});

describe('resolveAutomationDirectoryMatch', () => {
    it('recognizes symlink and canonical paths that resolve to the same directory', async () => {
        const realpath = async (path: string) => path === '/repo-link' ? '/actual/repo' : path;

        await expect(resolveAutomationDirectoryMatch(
            '/repo-link',
            '/actual/repo',
            realpath,
        )).resolves.toBe(true);
    });

    it('returns unknown when either directory cannot be resolved safely', async () => {
        await expect(resolveAutomationDirectoryMatch(
            '/missing',
            '/repo',
            async () => { throw new Error('missing'); },
        )).resolves.toBeNull();
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
