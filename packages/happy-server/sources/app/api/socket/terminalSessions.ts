/**
 * Registry of active terminal relay sessions. Server-side state for
 * specs/remote-terminal/ Phase 2 — the server is a thin routing layer between
 * the client (web-ui xterm panel) and the daemon (PTY on the user's machine).
 * Payloads are E2EE between the endpoints; this module only tracks routing.
 *
 * Sessions hold **socket ids, not Socket objects**. A Socket instance only
 * exists on the replica that owns the connection, so with replicas >= 2 the
 * daemon's frames arrive on a replica that has no object for the client side.
 * Ids are routable from anywhere: Socket.IO auto-joins every socket to a room
 * named after its id, so `io.to(socketId).emit()` crosses replicas via the
 * cluster adapter.
 *
 * The registry itself is shared through Redis when configured, because the
 * daemon's replica has to resolve a session it never opened. A process-local
 * Map fronts it as a write-through cache so per-frame routing never waits on a
 * Redis round-trip (spec AC6). Without Redis (single replica, local dev) the
 * cache *is* the registry and behaviour is unchanged.
 *
 * See specs/relay-cross-replica-routing.
 */

import { log } from '@/utils/log';

export const MAX_TERMINALS_PER_USER = 5;

export interface TerminalSession {
    id: string;
    userId: string;
    machineId: string;
    clientSocketId: string;
    daemonSocketId: string;
    createdAt: number;
}

/** Subset of ioredis the store needs. */
export interface TerminalSessionBackend {
    set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
    get(key: string): Promise<string | null>;
    del(...keys: string[]): Promise<unknown>;
    sadd(key: string, ...members: string[]): Promise<unknown>;
    srem(key: string, ...members: string[]): Promise<unknown>;
    smembers(key: string): Promise<string[]>;
    scard(key: string): Promise<number>;
    expire(key: string, ttlSeconds: number): Promise<unknown>;
}

// Long enough to outlive any realistic terminal, short enough that a replica
// killed mid-session cannot leak the record forever.
const SESSION_TTL_SECONDS = 12 * 60 * 60;

const sessionKey = (id: string) => `terminal:session:${id}`;
const userKey = (userId: string) => `terminal:user:${userId}`;
const socketKey = (socketId: string) => `terminal:socket:${socketId}`;

const cache = new Map<string, TerminalSession>();
let backend: TerminalSessionBackend | null = null;

export function setTerminalSessionBackend(next: TerminalSessionBackend | null): void {
    backend = next;
}

/**
 * Redis failures must degrade terminals, not crash the relay — a dead cluster
 * bus already costs the user cross-replica routing; it should not also throw
 * out of a socket event handler.
 */
async function tolerate<T>(what: string, op: () => Promise<T>, fallback: T): Promise<T> {
    if (!backend) return fallback;
    try {
        return await op();
    } catch (error) {
        log({ module: 'terminal-relay', level: 'error' }, `terminal session store ${what} failed: ${error}`);
        return fallback;
    }
}

export async function addTerminalSession(session: TerminalSession): Promise<void> {
    cache.set(session.id, session);
    await tolerate('add', async () => {
        await backend!.set(sessionKey(session.id), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
        await backend!.sadd(userKey(session.userId), session.id);
        await backend!.expire(userKey(session.userId), SESSION_TTL_SECONDS);
        // Reverse index so a disconnect on a replica that never cached the
        // session can still tear it down and notify the far endpoint.
        for (const socketId of [session.clientSocketId, session.daemonSocketId]) {
            await backend!.sadd(socketKey(socketId), session.id);
            await backend!.expire(socketKey(socketId), SESSION_TTL_SECONDS);
        }
    }, undefined);
}

export async function getTerminalSession(id: string | undefined | null): Promise<TerminalSession | null> {
    if (!id) return null;
    const cached = cache.get(id);
    if (cached) return cached;
    const raw = await tolerate<string | null>('get', () => backend!.get(sessionKey(id)), null);
    if (!raw) return null;
    try {
        const session = JSON.parse(raw) as TerminalSession;
        cache.set(session.id, session);
        return session;
    } catch {
        return null;
    }
}

export async function removeTerminalSession(id: string): Promise<boolean> {
    const known = cache.get(id) ?? await getTerminalSession(id);
    const existedLocally = cache.delete(id);
    if (!known) return existedLocally;
    await tolerate('remove', async () => {
        await backend!.del(sessionKey(id));
        await backend!.srem(userKey(known.userId), id);
        await backend!.srem(socketKey(known.clientSocketId), id);
        await backend!.srem(socketKey(known.daemonSocketId), id);
    }, undefined);
    return true;
}

export async function findTerminalSessionsBySocketId(socketId: string): Promise<TerminalSession[]> {
    const ids = new Set<string>();
    for (const s of cache.values()) {
        if (s.clientSocketId === socketId || s.daemonSocketId === socketId) ids.add(s.id);
    }
    for (const id of await tolerate<string[]>('index', () => backend!.smembers(socketKey(socketId)), [])) {
        ids.add(id);
    }
    const out: TerminalSession[] = [];
    for (const id of ids) {
        const session = await getTerminalSession(id);
        if (session) out.push(session);
    }
    return out;
}

export async function countActiveSessionsForUser(userId: string): Promise<number> {
    const local = () => {
        let n = 0;
        for (const s of cache.values()) if (s.userId === userId) n++;
        return n;
    };
    if (!backend) return local();
    // The cap is per user, not per replica — a local count silently multiplied
    // the ceiling by the replica count.
    return tolerate<number>('count', () => backend!.scard(userKey(userId)), local());
}

/** Test-only — clears the process-local cache (models a fresh replica). */
export function _resetTerminalSessionsForTest(): void {
    cache.clear();
}
