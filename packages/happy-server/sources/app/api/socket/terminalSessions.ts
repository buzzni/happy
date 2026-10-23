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
    /**
     * Codex CLI benchmark D4 B-R2 — set once the daemon reports the PTY ended.
     * The record then lives only for CLOSED_SESSION_TTL_SECONDS, so a client
     * that was detached at that moment can still resume into the exit. Kept in
     * the shared record, not a replica-local timer: the daemon's close and the
     * client's return may land on different replicas.
     */
    closedAt?: number;
    exit?: { code: number; signal: number | null };
    /** The daemon socket left after the close; a resume is answered from `exit`. */
    daemonGone?: boolean;
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

/**
 * How long an ended terminal's record stays resolvable. Matches the daemon's
 * own retain window (happy-cli `EXITED_TERMINAL_RETAIN_MS`) and the client
 * reattach grace, so the three agree on when "ended" turns into "unknown".
 */
export const CLOSED_SESSION_TTL_SECONDS = 30;

/** Seconds a record may still live: a closed one keeps its short clock on every rewrite. */
function ttlSecondsFor(session: TerminalSession): number {
    if (session.closedAt === undefined) return SESSION_TTL_SECONDS;
    const left = session.closedAt + CLOSED_SESSION_TTL_SECONDS * 1000 - Date.now();
    return Math.max(1, Math.ceil(left / 1000));
}

const sessionKey = (id: string) => `terminal:session:${id}`;
const userKey = (userId: string) => `terminal:user:${userId}`;
const socketKey = (socketId: string) => `terminal:socket:${socketId}`;

const cache = new Map<string, TerminalSession>();
let backend: TerminalSessionBackend | null = null;

export function setTerminalSessionBackend(next: TerminalSessionBackend | null): void {
    backend = next;
}

/**
 * Cluster event telling peer replicas to drop their cached copy of a record.
 *
 * Every replica caches the records it routes for, and nothing else ever
 * corrected those copies: once a client reconnected onto another replica and
 * was rebound there, the daemon's replica kept sending output to the dead
 * client id. A rebind, a close and a removal now each tell the peers, which
 * re-read the record from the shared store on their next lookup.
 */
export const TERMINAL_SESSION_CHANGED_EVENT = 'terminal-session-changed';

let notifyPeers: ((id: string) => void) | null = null;

/** `io` is the Socket.IO server; peers are reached through its cluster adapter. */
export function registerTerminalSessionClusterListeners(io: {
    on(event: string, listener: (message: { id?: unknown }) => void): unknown;
    serverSideEmit?(event: string, message: { id: string }): unknown;
}): void {
    io.on(TERMINAL_SESSION_CHANGED_EVENT, (message) => {
        if (typeof message?.id === 'string') forgetCachedTerminalSession(message.id);
    });
    if (typeof io.serverSideEmit !== 'function') return;
    notifyPeers = (id) => { io.serverSideEmit!(TERMINAL_SESSION_CHANGED_EVENT, { id }); };
}

/** Test seam: what a peer replica's cluster listener runs. */
export function setTerminalSessionPeerNotifier(next: ((id: string) => void) | null): void {
    notifyPeers = next;
}

export function forgetCachedTerminalSession(id: string): void {
    cache.delete(id);
}

function tellPeers(id: string): void {
    // Without a shared store there is one replica and no peer to tell (the
    // in-memory adapter's serverSideEmit would only print a warning).
    if (!notifyPeers || !backend) return;
    try {
        notifyPeers(id);
    } catch (error) {
        log({ module: 'terminal-relay', level: 'error' }, `terminal session peer notify failed: ${error}`);
    }
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

/**
 * Points one side of a session at a different socket, keeping the reverse
 * index in step.
 *
 * specs/machine-socket-duplicate-registration/ — the ids in a session record
 * are a routing target, not an identity. Both endpoints legitimately change
 * socket id while the terminal is still the same terminal: the desktop
 * terminal socket is opened with reconnection enabled precisely so a blip does
 * not kill the panel, and a daemon re-handshake produces a fresh sid too.
 * Freezing the ids at open time meant every such change silently black-holed
 * the traffic — `io.to(deadId).emit()` is a no-op, and the frames coming back
 * matched neither side of the pair, so they were dropped as well.
 *
 * Returns the updated session, or null when there is nothing to rebind.
 */
export async function rebindTerminalSessionSocket(
    id: string,
    side: 'client' | 'daemon',
    socketId: string,
): Promise<TerminalSession | null> {
    const current = await getTerminalSession(id);
    if (!current) return null;
    const previous = side === 'client' ? current.clientSocketId : current.daemonSocketId;
    if (previous === socketId) return current;
    const next: TerminalSession = side === 'client'
        ? { ...current, clientSocketId: socketId }
        : { ...current, daemonSocketId: socketId };
    cache.set(next.id, next);
    await tolerate('rebind', async () => {
        await backend!.set(sessionKey(next.id), JSON.stringify(next), 'EX', ttlSecondsFor(next));
        await backend!.srem(socketKey(previous), next.id);
        await backend!.sadd(socketKey(socketId), next.id);
        await backend!.expire(socketKey(socketId), SESSION_TTL_SECONDS);
    }, undefined);
    tellPeers(next.id);
    return next;
}

export async function getTerminalSession(id: string | undefined | null): Promise<TerminalSession | null> {
    if (!id) return null;
    const cached = cache.get(id);
    if (cached) return cached;
    const raw = await tolerate<string | null>('get', () => backend!.get(sessionKey(id)), null);
    if (!raw) return null;
    try {
        const session = JSON.parse(raw) as TerminalSession;
        cacheSession(session);
        return session;
    } catch {
        return null;
    }
}

/**
 * Like getTerminalSession, but asks the shared store first when there is one.
 *
 * The local cache does not learn when a record's short closed TTL runs out in
 * the store, and a peer notice can be missed; that is fine for per-frame
 * routing (AC6) but not for the questions a resume asks — "has this terminal
 * ended?", "does it still exist?".
 *
 * `undefined` means nobody can tell: the store could not be read and this
 * replica holds no copy. Callers must not turn that into "unknown".
 */
export async function getTerminalSessionFresh(id: string | undefined | null): Promise<TerminalSession | null | undefined> {
    if (!id) return null;
    const cached = cache.get(id) ?? null;
    if (!backend) return cached;
    const raw = await tolerate<string | null | undefined>('get', () => backend!.get(sessionKey(id)), undefined);
    if (raw === undefined) return cached ?? undefined;
    if (raw === null) {
        // Gone from the store. A closed copy here has simply expired. A live
        // copy may be one the store never got (its write at open was
        // tolerated as a failure) — keep it rather than end a working terminal
        // on that evidence; a removal elsewhere reaches this cache as a peer notice.
        if (cached && cached.closedAt === undefined) return cached;
        cache.delete(id);
        return null;
    }
    try {
        const session = JSON.parse(raw) as TerminalSession;
        cacheSession(session);
        return session;
    } catch {
        return null;
    }
}

const closedCacheTimers = new Map<string, NodeJS.Timeout>();

/** Caches a record; a closed one also gets a local expiry matching its store TTL. */
function cacheSession(session: TerminalSession): void {
    cache.set(session.id, session);
    if (session.closedAt === undefined) return;
    const existing = closedCacheTimers.get(session.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        closedCacheTimers.delete(session.id);
        if (cache.get(session.id)?.closedAt !== undefined) cache.delete(session.id);
    }, ttlSecondsFor(session) * 1000);
    timer.unref?.();
    closedCacheTimers.set(session.id, timer);
}

async function writeClosedSession(next: TerminalSession, what: string): Promise<void> {
    // Without a shared store the cache *is* the registry, so its expiry matters there too.
    cacheSession(next);
    await tolerate(what, async () => {
        await backend!.set(sessionKey(next.id), JSON.stringify(next), 'EX', ttlSecondsFor(next));
        // An ended terminal no longer counts toward the per-user cap.
        await backend!.srem(userKey(next.userId), next.id);
    }, undefined);
    tellPeers(next.id);
}

/**
 * Records that the daemon reported this terminal's exit (Codex CLI benchmark
 * D4 B-R2). The record is kept, with a short TTL, rather than removed: the
 * relay cannot know whether the client actually received the close. A second
 * report keeps the first exit and its clock, so repeated resumes cannot keep an
 * ended terminal alive.
 */
export async function markTerminalSessionClosed(
    id: string,
    exit: { code: number; signal: number | null },
): Promise<TerminalSession | null> {
    const current = await getTerminalSessionFresh(id);
    if (!current) return null;
    if (current.closedAt !== undefined) return current;
    const next: TerminalSession = { ...current, closedAt: Date.now(), exit: { code: exit.code, signal: exit.signal } };
    await writeClosedSession(next, 'close');
    return next;
}

/** The daemon socket of an ended terminal went away; later resumes are answered from the stored exit. */
export async function markClosedTerminalSessionDaemonGone(id: string): Promise<TerminalSession | null> {
    const current = await getTerminalSessionFresh(id);
    if (!current || current.closedAt === undefined) return null;
    if (current.daemonGone) return current;
    const next: TerminalSession = { ...current, daemonGone: true };
    await writeClosedSession(next, 'daemon-gone');
    return next;
}

export async function removeTerminalSession(id: string): Promise<boolean> {
    const known = cache.get(id) ?? await getTerminalSession(id);
    const existedLocally = cache.delete(id);
    const closedTimer = closedCacheTimers.get(id);
    if (closedTimer) {
        clearTimeout(closedTimer);
        closedCacheTimers.delete(id);
    }
    if (!known) return existedLocally;
    await tolerate('remove', async () => {
        await backend!.del(sessionKey(id));
        await backend!.srem(userKey(known.userId), id);
        await backend!.srem(socketKey(known.clientSocketId), id);
        await backend!.srem(socketKey(known.daemonSocketId), id);
    }, undefined);
    tellPeers(id);
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
        for (const s of cache.values()) if (s.userId === userId && s.closedAt === undefined) n++;
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
    for (const timer of closedCacheTimers.values()) clearTimeout(timer);
    closedCacheTimers.clear();
}
