import { beforeEach, describe, expect, it } from 'vitest';
import {
    addTerminalSession,
    countActiveSessionsForUser,
    findTerminalSessionsBySocketId,
    getTerminalSession,
    removeTerminalSession,
    setTerminalSessionBackend,
    _resetTerminalSessionsForTest,
} from './terminalSessions';

/** Minimal in-memory stand-in for the subset of ioredis the store uses. */
class FakeRedis {
    strings = new Map<string, string>();
    sets = new Map<string, Set<string>>();
    calls: string[] = [];

    async set(key: string, value: string, _mode?: string, _ttl?: number) {
        this.calls.push(`set ${key}`);
        this.strings.set(key, value);
        return 'OK';
    }
    async get(key: string) {
        this.calls.push(`get ${key}`);
        return this.strings.get(key) ?? null;
    }
    async del(...keys: string[]) {
        for (const k of keys) { this.calls.push(`del ${k}`); this.strings.delete(k); this.sets.delete(k); }
        return keys.length;
    }
    async sadd(key: string, ...members: string[]) {
        const s = this.sets.get(key) ?? new Set<string>();
        members.forEach((m) => s.add(m));
        this.sets.set(key, s);
        return members.length;
    }
    async srem(key: string, ...members: string[]) {
        const s = this.sets.get(key);
        members.forEach((m) => s?.delete(m));
        return 1;
    }
    async smembers(key: string) {
        this.calls.push(`smembers ${key}`);
        return [...(this.sets.get(key) ?? [])];
    }
    async scard(key: string) {
        this.calls.push(`scard ${key}`);
        return this.sets.get(key)?.size ?? 0;
    }
    async expire() { return 1; }
}

const session = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    userId: 'u1',
    machineId: 'm1',
    clientSocketId: 'client-1',
    daemonSocketId: 'daemon-1',
    createdAt: 1,
    ...over,
} as any);

describe('terminal session store — no Redis configured (single replica)', () => {
    beforeEach(() => {
        setTerminalSessionBackend(null);
        _resetTerminalSessionsForTest();
    });

    it('shouldStillRoundTripThroughTheLocalMap', async () => {
        await addTerminalSession(session());
        expect((await getTerminalSession('s1'))?.machineId).toBe('m1');
        expect(await countActiveSessionsForUser('u1')).toBe(1);
        expect(await removeTerminalSession('s1')).toBe(true);
        expect(await getTerminalSession('s1')).toBeNull();
    });
});

describe('terminal session store — Redis configured (multi replica)', () => {
    let redis: FakeRedis;

    beforeEach(() => {
        redis = new FakeRedis();
        setTerminalSessionBackend(redis as any);
        _resetTerminalSessionsForTest();
    });

    it('shouldResolveASessionOpenedOnAnotherReplica', async () => {
        await addTerminalSession(session());
        // Second replica: never saw the open, so its local cache is empty.
        _resetTerminalSessionsForTest();

        const got = await getTerminalSession('s1');
        expect(got).not.toBeNull();
        expect(got!.clientSocketId).toBe('client-1');
        expect(got!.daemonSocketId).toBe('daemon-1');
    });

    it('shouldNotHitRedisOnceTheSessionIsCachedLocally', async () => {
        // AC6: terminal keystrokes and PTY output must not be gated on a Redis
        // round-trip. First lookup populates the cache; the rest are local.
        await addTerminalSession(session());
        _resetTerminalSessionsForTest();

        await getTerminalSession('s1');
        const afterFirst = redis.calls.filter((c) => c.startsWith('get')).length;
        await getTerminalSession('s1');
        await getTerminalSession('s1');

        expect(redis.calls.filter((c) => c.startsWith('get')).length).toBe(afterFirst);
    });

    it('shouldCountSessionsAcrossReplicasNotJustThisProcess', async () => {
        // The per-user cap was previously local, so replicas=2 silently doubled it.
        await addTerminalSession(session({ id: 's1' }));
        await addTerminalSession(session({ id: 's2', clientSocketId: 'c2' }));
        _resetTerminalSessionsForTest();

        expect(await countActiveSessionsForUser('u1')).toBe(2);
        expect(await countActiveSessionsForUser('nobody')).toBe(0);
    });

    it('shouldFindSessionsForASocketThisReplicaNeverCached', async () => {
        // The daemon can disconnect on a replica that never handled a frame for
        // the session; without a shared reverse index the client is never told.
        await addTerminalSession(session());
        _resetTerminalSessionsForTest();

        const found = await findTerminalSessionsBySocketId('daemon-1');
        expect(found.map((s) => s.id)).toEqual(['s1']);
    });

    it('shouldRemoveTheSessionEverywhereSoItCannotBeResolvedAgain', async () => {
        await addTerminalSession(session());
        await removeTerminalSession('s1');
        _resetTerminalSessionsForTest();

        expect(await getTerminalSession('s1')).toBeNull();
        expect(await countActiveSessionsForUser('u1')).toBe(0);
        expect(await findTerminalSessionsBySocketId('daemon-1')).toEqual([]);
    });

    it('shouldFallBackToLocalStateWhenRedisFailsInsteadOfThrowing', async () => {
        // A dead cluster bus must degrade terminals, not crash the handler.
        await addTerminalSession(session());
        const broken = {
            get: async () => { throw new Error('READONLY'); },
            smembers: async () => { throw new Error('READONLY'); },
            scard: async () => { throw new Error('READONLY'); },
            set: async () => { throw new Error('READONLY'); },
            del: async () => { throw new Error('READONLY'); },
            sadd: async () => { throw new Error('READONLY'); },
            srem: async () => { throw new Error('READONLY'); },
            expire: async () => { throw new Error('READONLY'); },
        };
        setTerminalSessionBackend(broken as any);

        expect((await getTerminalSession('s1'))?.id).toBe('s1');
        await expect(countActiveSessionsForUser('u1')).resolves.toBe(1);
    });
});
