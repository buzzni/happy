import { beforeEach, describe, expect, it, vi } from 'vitest';

const connections = new Set<any>();

/**
 * Frames are routed with `io.to(socketId).emit(...)` rather than by holding a
 * Socket object, so they reach the endpoint on whichever replica owns it
 * (specs/relay-cross-replica-routing). Record every such emit.
 */
const roomEmits: Array<{ room: string; event: string; payload: any }> = [];

vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: {
        server: {
            to: (room: string) => ({
                emit: (event: string, payload: any) => { roomEmits.push({ room, event, payload }); },
            }),
            // The daemon is resolved through the machine room so the lookup
            // crosses replicas. Sockets that engine.io has already torn down
            // are gone from the room, so the fixture mirrors that by dropping
            // `connected === false` entries here rather than in the handler.
            in: (room: string) => ({
                timeout: () => ({
                    fetchSockets: async () => {
                        const machineId = room.split(':machine:')[1];
                        return [...connections]
                            .filter((c) => c.connectionType === 'machine-scoped'
                                && c.machineId === machineId
                                && c.socket.connected)
                            .map((c) => Object.assign(c.socket, {
                                data: {
                                    clientType: 'machine-scoped',
                                    machineId: c.machineId,
                                    connectedAt: c.connectedAt,
                                },
                            }));
                    },
                }),
            }),
        },
    },
}));

import { CLIENT_REATTACH_GRACE_MS, terminalRelayHandler } from './terminalRelayHandler';
import { _resetTerminalSessionsForTest, getTerminalSession } from './terminalSessions';

class FakeSocket {
    connected = true;
    /** Forwards this socket received via `timeout().emitWithAck()`. */
    forwards: Array<{ event: string; payload: any }> = [];
    /** false → the daemon never calls the ack (socket.io rejects on timeout). */
    respondsToAck = true;
    private handlers = new Map<string, (...args: any[]) => unknown>();

    constructor(readonly id: string) {}

    on(event: string, handler: (...args: any[]) => unknown) {
        this.handlers.set(event, handler);
    }

    /** Events emitted straight back on this socket (answers meant for the requester only). */
    ownEmits: Array<{ event: string; payload: any }> = [];

    emit(event: string, payload: any) {
        this.ownEmits.push({ event, payload });
    }

    /** Extra fields the daemon returns in its terminal-open-fwd ack. */
    ackExtras: Record<string, unknown> = {};

    /** Runs when the daemon receives a forward, before it acks (it may already emit output then). */
    onForward?: (event: string, payload: any) => Promise<void> | void;

    timeout(_ms: number) {
        return {
            emitWithAck: async (event: string, payload: any) => {
                this.forwards.push({ event, payload });
                await this.onForward?.(event, payload);
                if (!this.respondsToAck) throw new Error('operation has timed out');
                return { ok: true, ...this.ackExtras };
            },
        };
    }

    async trigger(event: string, ...args: unknown[]) {
        const handler = this.handlers.get(event);
        if (!handler) throw new Error(`missing handler: ${event}`);
        return handler(...args);
    }
}

/**
 * `connectedAt` is the recency signal the handler ranks on — a monotonically
 * increasing counter here so "registered later" means "newer", matching the
 * insertion-order intent of the original fixture.
 */
let nextConnectedAt = 1;
function registerMachineSocket(machineId: string, socket: FakeSocket) {
    connections.add({
        connectionType: 'machine-scoped',
        machineId,
        userId: 'u1',
        socket,
        connectedAt: nextConnectedAt++,
    });
}

describe('terminalRelayHandler machine socket selection', () => {
    beforeEach(() => {
        connections.clear();
        roomEmits.length = 0;
        _resetTerminalSessionsForTest();
    });

    it('forwards terminal-open to the newest machine socket when a stale one is still registered', async () => {
        // A daemon that reconnects after a network flap registers a second
        // socket while happy-server still holds the dead one (up to
        // pingInterval + pingTimeout). The dead socket never acks.
        const stale = new FakeSocket('stale');
        stale.respondsToAck = false;
        const live = new FakeSocket('live');
        registerMachineSocket('m1', stale);
        registerMachineSocket('m1', live);

        const client = new FakeSocket('client');
        terminalRelayHandler('u1', client as any);

        const ack = vi.fn();
        await client.trigger('terminal-open', { machineId: 'm1', params: 'enc' }, ack);

        expect(live.forwards.map(f => f.event)).toEqual(['terminal-open-fwd']);
        expect(stale.forwards).toHaveLength(0);
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('registers the session before the daemon is asked to open it, so output it emits at once is routed', async () => {
        // The daemon spawns the PTY and the shell prints its prompt right away, often before its ack has
        // reached this replica; on another replica that frame must already find the session (it is dropped
        // otherwise and a web terminal stays blank).
        const daemon = new FakeSocket('daemon');
        let seenByDaemon: unknown = 'not checked';
        daemon.onForward = async (_event, payload) => { seenByDaemon = await getTerminalSession(payload.sessionId); };
        registerMachineSocket('m1', daemon);
        const client = new FakeSocket('client');
        terminalRelayHandler('u1', client as any);
        const ack = vi.fn();
        await client.trigger('terminal-open', { machineId: 'm1', params: 'enc' }, ack);
        expect(seenByDaemon).toMatchObject({ userId: 'u1', machineId: 'm1', clientSocketId: 'client', daemonSocketId: 'daemon' });
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('forgets the session again when the daemon does not open it', async () => {
        const daemon = new FakeSocket('daemon');
        daemon.respondsToAck = false;
        registerMachineSocket('m1', daemon);
        const client = new FakeSocket('client');
        terminalRelayHandler('u1', client as any);
        const ack = vi.fn();
        await client.trigger('terminal-open', { machineId: 'm1', params: 'enc' }, ack);
        const sessionId = daemon.forwards[0].payload.sessionId;
        expect(await getTerminalSession(sessionId)).toBeNull();
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    });

    it('skips machine sockets that are already disconnected', async () => {
        const disconnected = new FakeSocket('disconnected');
        disconnected.connected = false;
        disconnected.respondsToAck = false;
        const live = new FakeSocket('live');
        registerMachineSocket('m1', disconnected);
        registerMachineSocket('m1', live);

        const client = new FakeSocket('client');
        terminalRelayHandler('u1', client as any);

        const ack = vi.fn();
        await client.trigger('terminal-open', { machineId: 'm1', params: 'enc' }, ack);

        expect(live.forwards).toHaveLength(1);
        expect(disconnected.forwards).toHaveLength(0);
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('reports the machine as not connected when every machine socket is dead', async () => {
        const disconnected = new FakeSocket('disconnected');
        disconnected.connected = false;
        registerMachineSocket('m1', disconnected);

        const client = new FakeSocket('client');
        terminalRelayHandler('u1', client as any);

        const ack = vi.fn();
        await client.trigger('terminal-open', { machineId: 'm1', params: 'enc' }, ack);

        expect(disconnected.forwards).toHaveLength(0);
        expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Machine not connected for this user' });
    });
});

describe('terminalRelayHandler frame routing', () => {
    beforeEach(() => {
        connections.clear();
        roomEmits.length = 0;
        _resetTerminalSessionsForTest();
    });

    /** Opens a session and returns the pieces needed to drive both directions. */
    async function openSession() {
        const daemon = new FakeSocket('daemon-1');
        registerMachineSocket('m1', daemon);
        const client = new FakeSocket('client-1');
        terminalRelayHandler('u1', client as any);
        // The daemon side registers its own handlers on its own socket — on a
        // second replica this is a different process, which is exactly why
        // routing must go through io.to(socketId) and not a Socket object.
        terminalRelayHandler('u1', daemon as any);

        const ack = vi.fn();
        await client.trigger('terminal-open', { machineId: 'm1', params: 'enc' }, ack);
        const sessionId = ack.mock.calls[0][0].sessionId;
        roomEmits.length = 0;
        return { client, daemon, sessionId };
    }

    it('shouldRouteClientFramesToTheDaemonSocketIdRoom', async () => {
        const { client, sessionId } = await openSession();
        await client.trigger('terminal-frame', { sessionId, data: 'cipher-in' });

        expect(roomEmits).toEqual([
            { room: 'daemon-1', event: 'terminal-frame-fwd', payload: { sessionId, data: 'cipher-in' } },
        ]);
    });

    it('shouldRouteDaemonFramesBackToTheClientSocketIdRoom', async () => {
        // This is the direction that was broken cross-replica: the daemon's
        // frame lands on the daemon's replica, which held no Socket object for
        // the client. Addressing the client's own id-room fixes it.
        const { daemon, sessionId } = await openSession();
        await daemon.trigger('terminal-frame', { sessionId, data: 'cipher-out' });

        expect(roomEmits).toEqual([
            { room: 'client-1', event: 'terminal-frame', payload: { sessionId, data: 'cipher-out' } },
        ]);
    });

    /*
     * specs/machine-socket-duplicate-registration/ — the pair is identified by
     * *who each socket is*, not by ids frozen at open time. A socket belonging
     * to another user is still no part of it, which is the boundary the old
     * id comparison was really enforcing.
     */
    it('shouldDropFramesFromAnotherUsersSocket', async () => {
        const { sessionId } = await openSession();
        const stranger = new FakeSocket('stranger');
        terminalRelayHandler('u2', stranger as any);

        await stranger.trigger('terminal-frame', { sessionId, data: 'guessed' });

        expect(roomEmits).toEqual([]);
    });

    it('shouldDropFramesForAnUnknownSessionId', async () => {
        await openSession();
        const client2 = new FakeSocket('client-2');
        terminalRelayHandler('u1', client2 as any);

        await client2.trigger('terminal-frame', { sessionId: 'no-such-session', data: 'x' });

        expect(roomEmits).toEqual([]);
    });

    /*
     * The reconnect this whole change exists for: the desktop terminal socket
     * is opened with reconnection enabled, and a reconnect arrives as a
     * different socket id. Before rebinding, the daemon's output went to the
     * dead id and the user's keystrokes matched neither side — the terminal
     * showed its prompt and then took no input at all.
     */
    it('shouldRebindTheClientSideWhenTheSocketIdChanges', async () => {
        const { daemon, sessionId } = await openSession();

        const reconnected = new FakeSocket('client-2');
        terminalRelayHandler('u1', reconnected as any);
        await reconnected.trigger('terminal-frame', { sessionId, data: 'typed-after-reconnect' });

        expect(roomEmits).toEqual([
            { room: 'daemon-1', event: 'terminal-frame-fwd', payload: { sessionId, data: 'typed-after-reconnect' } },
        ]);

        // And the daemon's output now follows the client to its new id.
        roomEmits.length = 0;
        await daemon.trigger('terminal-frame', { sessionId, data: 'cipher-out' });
        expect(roomEmits).toEqual([
            { room: 'client-2', event: 'terminal-frame', payload: { sessionId, data: 'cipher-out' } },
        ]);
    });

    it('shouldRebindTheDaemonSideWhenTheMachineSocketIdChanges', async () => {
        const { sessionId } = await openSession();

        const reconnectedDaemon = new FakeSocket('daemon-2');
        registerMachineSocket('m1', reconnectedDaemon);
        // `data` is stamped by the machine-room lookup in production; the
        // fixture only does it inside fetchSockets, so mirror it here.
        (reconnectedDaemon as any).data = { clientType: 'machine-scoped', machineId: 'm1' };
        terminalRelayHandler('u1', reconnectedDaemon as any);

        await reconnectedDaemon.trigger('terminal-frame', { sessionId, data: 'out-after-reconnect' });
        expect(roomEmits).toEqual([
            { room: 'client-1', event: 'terminal-frame', payload: { sessionId, data: 'out-after-reconnect' } },
        ]);
    });

    it('shouldForwardResizeOnlyFromTheClient', async () => {
        const { client, daemon, sessionId } = await openSession();

        await daemon.trigger('terminal-resize', { sessionId, cols: 10, rows: 5 });
        expect(roomEmits).toEqual([]);

        await client.trigger('terminal-resize', { sessionId, cols: 120, rows: 40 });
        expect(roomEmits).toEqual([
            { room: 'daemon-1', event: 'terminal-resize-fwd', payload: { sessionId, cols: 120, rows: 40 } },
        ]);
    });

    it('shouldTellTheClientWhenTheDaemonSocketDisconnects', async () => {
        const { daemon, sessionId } = await openSession();
        await daemon.trigger('disconnect');

        expect(roomEmits).toEqual([
            {
                room: 'client-1',
                event: 'terminal-closed',
                payload: { sessionId, code: -1, signal: null, reason: 'daemon-disconnected' },
            },
        ]);
    });

    /*
     * A client disconnect is no longer a close. The PTY is still running and
     * the socket reconnects by design, so the session is held for a grace
     * window; only a client that never comes back closes the shell.
     */
    it('shouldTellTheDaemonWhenTheClientNeverComesBack', async () => {
        vi.useFakeTimers();
        try {
            const { client, sessionId } = await openSession();
            await client.trigger('disconnect');
            expect(roomEmits).toEqual([]);

            await vi.advanceTimersByTimeAsync(CLIENT_REATTACH_GRACE_MS + 1);
            expect(roomEmits).toEqual([
                { room: 'daemon-1', event: 'terminal-close-fwd', payload: { sessionId } },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('shouldKeepTheSessionWhenTheClientReturnsWithinTheGraceWindow', async () => {
        vi.useFakeTimers();
        try {
            const { client, sessionId } = await openSession();
            await client.trigger('disconnect');

            const reconnected = new FakeSocket('client-2');
            terminalRelayHandler('u1', reconnected as any);
            await reconnected.trigger('terminal-frame', { sessionId, data: 'still-here' });

            await vi.advanceTimersByTimeAsync(CLIENT_REATTACH_GRACE_MS * 2);

            // The forward landed and no close was ever sent to the daemon.
            expect(roomEmits).toEqual([
                { room: 'daemon-1', event: 'terminal-frame-fwd', payload: { sessionId, data: 'still-here' } },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    /*
     * After a rebind the superseded id is still in this replica's reverse
     * index. Its late `disconnect` must not tear down the terminal that
     * replaced it.
     */
    it('shouldIgnoreDisconnectFromASupersededClientSocket', async () => {
        vi.useFakeTimers();
        try {
            const { client, sessionId } = await openSession();

            const reconnected = new FakeSocket('client-2');
            terminalRelayHandler('u1', reconnected as any);
            await reconnected.trigger('terminal-frame', { sessionId, data: 'typed' });
            roomEmits.length = 0;

            await client.trigger('disconnect');
            await vi.advanceTimersByTimeAsync(CLIENT_REATTACH_GRACE_MS * 2);

            expect(roomEmits).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});

/*
 * specs/desktop-terminal-reliability/ Phase 3. The desktop client has spoken
 * this protocol since Phase 3 shipped, but nothing ever advertised `caps`, so
 * it ran in legacy mode the whole time — no replay after a reconnect, and a
 * gap in `seq` silently accepted as a hole.
 */
describe('terminalRelayHandler resume relay', () => {
    beforeEach(() => {
        connections.clear();
        roomEmits.length = 0;
        _resetTerminalSessionsForTest();
    });

    async function openSession(daemonAckExtras: Record<string, unknown> = {}) {
        const daemon = new FakeSocket('daemon-1');
        daemon.ackExtras = daemonAckExtras;
        registerMachineSocket('m1', daemon);
        const client = new FakeSocket('client-1');
        terminalRelayHandler('u1', client as any);
        terminalRelayHandler('u1', daemon as any);
        const ack = vi.fn();
        await client.trigger('terminal-open', { machineId: 'm1', params: 'enc' }, ack);
        const reply = ack.mock.calls[0][0];
        roomEmits.length = 0;
        return { client, daemon, sessionId: reply.sessionId, reply };
    }

    it('carries the daemon-advertised caps back to the client', async () => {
        const { reply } = await openSession({ caps: { resume: true, snapshot: true } });
        expect(reply).toMatchObject({ ok: true, caps: { resume: true, snapshot: true } });
    });

    it('advertises nothing of its own when the daemon is too old to claim caps', async () => {
        // The relay does not decide what is supported. An absent `caps` is what
        // keeps an older daemon working — the client degrades on purpose.
        const { reply } = await openSession();
        expect(reply.caps).toBeUndefined();
    });

    it('forwards a resume request to the daemon', async () => {
        const { client, sessionId } = await openSession({ caps: { resume: true } });
        await client.trigger('terminal-resume', { sessionId, afterSeq: 7 });

        expect(roomEmits).toEqual([
            { room: 'daemon-1', event: 'terminal-resume-fwd', payload: { sessionId, afterSeq: 7 } },
        ]);
    });

    it('accepts afterSeq 0, which is how a client says it has seen nothing', async () => {
        const { client, sessionId } = await openSession({ caps: { resume: true } });
        await client.trigger('terminal-resume', { sessionId, afterSeq: 0 });
        expect(roomEmits).toHaveLength(1);
        expect(roomEmits[0].payload).toEqual({ sessionId, afterSeq: 0 });
    });

    it('drops a resume carrying nonsense instead of passing it to the daemon', async () => {
        const { client, sessionId } = await openSession({ caps: { resume: true } });
        await client.trigger('terminal-resume', { sessionId, afterSeq: -1 });
        await client.trigger('terminal-resume', { sessionId, afterSeq: 'soon' });
        await client.trigger('terminal-resume', { sessionId });
        expect(roomEmits).toEqual([]);
    });

    it('ignores a resume coming from the daemon side', async () => {
        const { daemon, sessionId } = await openSession({ caps: { resume: true } });
        await daemon.trigger('terminal-resume', { sessionId, afterSeq: 3 });
        expect(roomEmits).toEqual([]);
    });

    it('routes a snapshot and a gap back to the client', async () => {
        const { daemon, sessionId } = await openSession({ caps: { resume: true, snapshot: true } });
        await daemon.trigger('terminal-snapshot', { sessionId, seq: 12, data: 'cipher-snap' });
        await daemon.trigger('terminal-frame-gap', { sessionId, fromSeq: 5 });

        expect(roomEmits).toEqual([
            { room: 'client-1', event: 'terminal-snapshot', payload: { sessionId, seq: 12, data: 'cipher-snap' } },
            { room: 'client-1', event: 'terminal-frame-gap', payload: { sessionId, fromSeq: 5 } },
        ]);
    });

    it('does not let a client forge a snapshot or a gap at itself', async () => {
        const { client, sessionId } = await openSession({ caps: { snapshot: true } });
        await client.trigger('terminal-snapshot', { sessionId, seq: 1, data: 'forged' });
        await client.trigger('terminal-frame-gap', { sessionId, fromSeq: 1 });
        expect(roomEmits).toEqual([]);
    });

    it('carries the seq on ordinary output frames', async () => {
        const { daemon, sessionId } = await openSession({ caps: { resume: true } });
        await daemon.trigger('terminal-frame', { sessionId, seq: 4, data: 'cipher-out' });

        expect(roomEmits).toEqual([
            { room: 'client-1', event: 'terminal-frame', payload: { sessionId, seq: 4, data: 'cipher-out' } },
        ]);
    });

    it('survives a legacy daemon frame that carries no seq', async () => {
        // The client reads a missing seq as "the next one", which is what kept
        // pre-Phase-3 daemons working.
        const { daemon, sessionId } = await openSession();
        await daemon.trigger('terminal-frame', { sessionId, data: 'cipher-out' });
        expect(roomEmits[0].payload).toEqual({ sessionId, seq: undefined, data: 'cipher-out' });
    });

    /*
     * specs/codexcli-daemon-stream-durability B3.1b — paged resume. The relay
     * copies fields by name, so the new ones are added here; a request without
     * maxChars still carries exactly the old fields, and so does an answer
     * without paging fields.
     */
    it('forwards maxChars when the client asks for a paged resume, and only then', async () => {
        const { client, sessionId } = await openSession({ caps: { resume: true, pagedResume: true } });
        await client.trigger('terminal-resume', { sessionId, afterSeq: 3, maxChars: 262144 });
        await client.trigger('terminal-resume', { sessionId, afterSeq: 3, maxChars: 'lots' });
        await client.trigger('terminal-resume', { sessionId, afterSeq: 3, maxChars: -1 });

        expect(roomEmits.map((e) => e.payload)).toEqual([
            { sessionId, afterSeq: 3, maxChars: 262144 },
            { sessionId, afterSeq: 3 },
            { sessionId, afterSeq: 3 },
        ]);
        expect(Object.keys(roomEmits[1].payload)).toEqual(['sessionId', 'afterSeq']);
    });

    it('carries the paging fields on the frame, snapshot and gap that answer a paged resume', async () => {
        const { daemon, sessionId } = await openSession({ caps: { resume: true, pagedResume: true } });
        await daemon.trigger('terminal-frame', { sessionId, seq: 9, data: 'c', more: true, nextSeq: 9 });
        await daemon.trigger('terminal-snapshot', { sessionId, seq: 4, data: 's', more: false, nextSeq: 4, droppedChars: 120 });
        await daemon.trigger('terminal-frame-gap', { sessionId, fromSeq: 2, droppedChars: 7 });

        expect(roomEmits.map((e) => e.payload)).toEqual([
            { sessionId, seq: 9, data: 'c', more: true, nextSeq: 9 },
            { sessionId, seq: 4, data: 's', more: false, nextSeq: 4, droppedChars: 120 },
            { sessionId, fromSeq: 2, droppedChars: 7 },
        ]);
    });

    it('drops paging fields of the wrong type and adds none to an ordinary frame', async () => {
        const { daemon, sessionId } = await openSession({ caps: { resume: true } });
        await daemon.trigger('terminal-frame', { sessionId, seq: 1, data: 'c', more: 'yes', nextSeq: 'x' });
        await daemon.trigger('terminal-frame', { sessionId, seq: 2, data: 'd' });
        await daemon.trigger('terminal-frame-gap', { sessionId, fromSeq: 2, droppedChars: 'many' });

        expect(Object.keys(roomEmits[0].payload)).toEqual(['sessionId', 'seq', 'data']);
        expect(Object.keys(roomEmits[1].payload)).toEqual(['sessionId', 'seq', 'data']);
        expect(Object.keys(roomEmits[2].payload)).toEqual(['sessionId', 'fromSeq']);
    });

    /*
     * The two fixes meeting: P0-3 lets a reconnected client re-claim its
     * session, and resume is what makes that recovery lossless.
     */
    it('lets a client that reconnected on a new socket resume its session', async () => {
        const { sessionId } = await openSession({ caps: { resume: true } });
        const reconnected = new FakeSocket('client-2');
        terminalRelayHandler('u1', reconnected as any);

        await reconnected.trigger('terminal-resume', { sessionId, afterSeq: 2 });

        expect(roomEmits).toEqual([
            { room: 'daemon-1', event: 'terminal-resume-fwd', payload: { sessionId, afterSeq: 2 } },
        ]);
    });
});

/** Minimal in-memory stand-in for the ioredis subset, with TTLs recorded. */
class FakeRedis {
    strings = new Map<string, string>();
    ttls = new Map<string, number>();
    sets = new Map<string, Set<string>>();

    async set(key: string, value: string, _mode: string, ttlSeconds: number) {
        this.strings.set(key, value);
        this.ttls.set(key, ttlSeconds);
        return 'OK';
    }
    async get(key: string) { return this.strings.get(key) ?? null; }
    async del(...keys: string[]) {
        for (const k of keys) { this.strings.delete(k); this.sets.delete(k); this.ttls.delete(k); }
        return keys.length;
    }
    async sadd(key: string, ...members: string[]) {
        const set = this.sets.get(key) ?? new Set<string>();
        members.forEach((m) => set.add(m));
        this.sets.set(key, set);
        return members.length;
    }
    async srem(key: string, ...members: string[]) {
        const set = this.sets.get(key);
        members.forEach((m) => set?.delete(m));
        return 1;
    }
    async smembers(key: string) { return [...(this.sets.get(key) ?? [])]; }
    async scard(key: string) { return this.sets.get(key)?.size ?? 0; }
    async expire() { return 1; }

    record(id: string) {
        const raw = this.strings.get(`terminal:session:${id}`);
        return raw ? JSON.parse(raw) : null;
    }
}

/*
 * Codex CLI benchmark D4 B-R2 — a terminal that ends while its client is away.
 *
 * Each "replica" is a fresh module instance: its own session cache and its own
 * reattach timers, sharing only the fake Redis and the cluster emit — so a
 * decision that leans on replica-local state (the old "is a reattach timer
 * pending here?") fails here the way it fails in production.
 */
describe('terminalRelayHandler ended terminal across replicas', () => {
    let redis: FakeRedis;

    let replicas: Array<typeof import('./terminalSessions')> = [];

    /** A fresh replica, wired to its peers the way the cluster adapter's serverSideEmit would. */
    async function loadReplica() {
        vi.resetModules();
        const relay = await import('./terminalRelayHandler');
        const store = await import('./terminalSessions');
        store.setTerminalSessionBackend(redis as any);
        const listeners: Array<(message: { id?: unknown }) => void> = [];
        store.registerTerminalSessionClusterListeners({
            on: (_event, listener) => { listeners.push(listener); },
            // serverSideEmit reaches every replica except the sender.
            serverSideEmit: (_event, message) => {
                for (const peer of replicas) if (peer !== store) peer.forgetCachedTerminalSession(message.id);
            },
        });
        replicas.push(store);
        return { relay, store };
    }

    beforeEach(() => {
        connections.clear();
        roomEmits.length = 0;
        redis = new FakeRedis();
        replicas = [];
    });

    it('a replica that cached the record follows a client rebound on another replica', async () => {
        const { daemon, sessionId } = await openAcrossReplicas();
        await daemon.trigger('terminal-frame', { sessionId, seq: 1, data: 'before' });
        const replicaC = await loadReplica();
        const back = new FakeSocket('client-2');
        replicaC.relay.terminalRelayHandler('u1', back as any);
        await back.trigger('terminal-frame', { sessionId, data: 'typed' });
        roomEmits.length = 0;

        await daemon.trigger('terminal-frame', { sessionId, seq: 2, data: 'after' });

        expect(roomEmits).toEqual([
            { room: 'client-2', event: 'terminal-frame', payload: { sessionId, seq: 2, data: 'after' } },
        ]);
    });

    /** Client handled by replica B, daemon by replica A. */
    async function openAcrossReplicas() {
        const replicaA = await loadReplica();
        const replicaB = await loadReplica();
        const daemon = new FakeSocket('daemon-1');
        registerMachineSocket('m1', daemon);
        (daemon as any).data = { clientType: 'machine-scoped', machineId: 'm1' };
        replicaA.relay.terminalRelayHandler('u1', daemon as any);
        const client = new FakeSocket('client-1');
        replicaB.relay.terminalRelayHandler('u1', client as any);
        const ack = vi.fn();
        await client.trigger('terminal-open', { machineId: 'm1', params: 'enc' }, ack);
        const sessionId = ack.mock.calls[0][0].sessionId;
        roomEmits.length = 0;
        return { replicaA, replicaB, daemon, client, sessionId };
    }

    it('keeps the record of a terminal that ended while the client was detached, so a resume on another replica reaches the daemon', async () => {
        vi.useFakeTimers();
        try {
            const { replicaB, daemon, client, sessionId } = await openAcrossReplicas();
            await client.trigger('disconnect');
            await daemon.trigger('terminal-closed', { sessionId, code: 0, signal: null });

            expect(roomEmits).toEqual([
                { room: 'client-1', event: 'terminal-closed', payload: { sessionId, code: 0, signal: null } },
            ]);
            expect(redis.record(sessionId)).toMatchObject({ closedAt: expect.any(Number), exit: { code: 0, signal: null } });
            expect(redis.ttls.get(`terminal:session:${sessionId}`)).toBe(30);
            expect(await replicaB.store.countActiveSessionsForUser('u1')).toBe(0);

            roomEmits.length = 0;
            const replicaC = await loadReplica();
            const back = new FakeSocket('client-2');
            replicaC.relay.terminalRelayHandler('u1', back as any);
            await back.trigger('terminal-resume', { sessionId, afterSeq: 4 });

            expect(roomEmits).toEqual([
                { room: 'daemon-1', event: 'terminal-resume-fwd', payload: { sessionId, afterSeq: 4 } },
            ]);
            // Rebinding the returning client must not stretch the closed record back to 12h.
            expect(redis.ttls.get(`terminal:session:${sessionId}`)).toBeLessThanOrEqual(30);

            // Replica B's reattach timer still fires, but must not close a terminal that already ended.
            roomEmits.length = 0;
            await vi.advanceTimersByTimeAsync(30_001);
            expect(roomEmits).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    /*
     * Cross review #3: the reattach window counts from the client leaving, the
     * retain window from the shell ending. A shell that ends late in the first
     * must not lose its exit code to it — the closed record runs out on its TTL.
     */
    it('keeps a terminal that ended late in the reattach window for its own retain window', async () => {
        vi.useFakeTimers();
        try {
            const { daemon, client, sessionId } = await openAcrossReplicas();
            await client.trigger('disconnect');
            await vi.advanceTimersByTimeAsync(25_000);
            await daemon.trigger('terminal-closed', { sessionId, code: 3, signal: null });
            await vi.advanceTimersByTimeAsync(10_000);

            roomEmits.length = 0;
            const replicaC = await loadReplica();
            const back = new FakeSocket('client-2');
            replicaC.relay.terminalRelayHandler('u1', back as any);
            await back.trigger('terminal-resume', { sessionId, afterSeq: 4 });

            expect(back.ownEmits).toEqual([]);
            expect(roomEmits).toEqual([
                { room: 'daemon-1', event: 'terminal-resume-fwd', payload: { sessionId, afterSeq: 4 } },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('relays the daemon\'s re-sent exit after a replay to the returning client', async () => {
        const { daemon, client, sessionId } = await openAcrossReplicas();
        await client.trigger('disconnect');
        await daemon.trigger('terminal-closed', { sessionId, code: 2, signal: null });
        const replicaC = await loadReplica();
        const back = new FakeSocket('client-2');
        replicaC.relay.terminalRelayHandler('u1', back as any);
        await back.trigger('terminal-resume', { sessionId, afterSeq: 0 });
        roomEmits.length = 0;

        await daemon.trigger('terminal-frame', { sessionId, seq: 1, data: 'tail' });
        await daemon.trigger('terminal-closed', { sessionId, code: 2, signal: null });

        expect(roomEmits).toEqual([
            { room: 'client-2', event: 'terminal-frame', payload: { sessionId, seq: 1, data: 'tail' } },
            { room: 'client-2', event: 'terminal-closed', payload: { sessionId, code: 2, signal: null } },
        ]);
    });

    /*
     * D4 I3·I4 merge: an ended terminal replayed page by page. Every page's
     * resume must still reach the daemon after the close was recorded, and the
     * daemon's exit — sent after the last page — must reach the client last.
     */
    it('carries a paged replay of an ended terminal across replicas, the exit after the last page', async () => {
        const { daemon, client, sessionId } = await openAcrossReplicas();
        await client.trigger('disconnect');
        await daemon.trigger('terminal-closed', { sessionId, code: 4, signal: null });
        const replicaC = await loadReplica();
        const back = new FakeSocket('client-2');
        replicaC.relay.terminalRelayHandler('u1', back as any);
        roomEmits.length = 0;

        await back.trigger('terminal-resume', { sessionId, afterSeq: 0, maxChars: 262_144 });
        await daemon.trigger('terminal-frame', { sessionId, seq: 1, data: 'p1', more: true, nextSeq: 1 });
        // The next page is asked for through yet another replica.
        const replicaD = await loadReplica();
        const again = new FakeSocket('client-2');
        replicaD.relay.terminalRelayHandler('u1', again as any);
        await again.trigger('terminal-resume', { sessionId, afterSeq: 1, maxChars: 262_144 });
        await daemon.trigger('terminal-frame', { sessionId, seq: 2, data: 'p2', more: false, nextSeq: 2 });
        await daemon.trigger('terminal-closed', { sessionId, code: 4, signal: null });

        expect(roomEmits).toEqual([
            { room: 'daemon-1', event: 'terminal-resume-fwd', payload: { sessionId, afterSeq: 0, maxChars: 262_144 } },
            { room: 'client-2', event: 'terminal-frame', payload: { sessionId, seq: 1, data: 'p1', more: true, nextSeq: 1 } },
            { room: 'daemon-1', event: 'terminal-resume-fwd', payload: { sessionId, afterSeq: 1, maxChars: 262_144 } },
            { room: 'client-2', event: 'terminal-frame', payload: { sessionId, seq: 2, data: 'p2', more: false, nextSeq: 2 } },
            { room: 'client-2', event: 'terminal-closed', payload: { sessionId, code: 4, signal: null } },
        ]);
        expect(back.ownEmits).toEqual([]);
        expect(again.ownEmits).toEqual([]);
    });

    it('answers from the stored exit when the daemon socket is gone too', async () => {
        const { daemon, client, sessionId } = await openAcrossReplicas();
        await client.trigger('disconnect');
        await daemon.trigger('terminal-closed', { sessionId, code: 5, signal: null });
        roomEmits.length = 0;
        await daemon.trigger('disconnect');
        // The terminal already ended with a real code; "daemon disconnected" would be a lie.
        expect(roomEmits).toEqual([]);

        const replicaC = await loadReplica();
        const back = new FakeSocket('client-2');
        replicaC.relay.terminalRelayHandler('u1', back as any);
        await back.trigger('terminal-resume', { sessionId, afterSeq: 0 });

        expect(roomEmits).toEqual([]);
        expect(back.ownEmits).toEqual([
            { event: 'terminal-closed', payload: { sessionId, code: 5, signal: null } },
        ]);
    });

    it('gives the same unknown-session answer for no record and for another user\'s record, to the requester only', async () => {
        const { sessionId } = await openAcrossReplicas();
        const replicaC = await loadReplica();
        const stranger = new FakeSocket('stranger');
        replicaC.relay.terminalRelayHandler('u2', stranger as any);
        const owner = new FakeSocket('client-3');
        replicaC.relay.terminalRelayHandler('u1', owner as any);

        await stranger.trigger('terminal-resume', { sessionId, afterSeq: 0 });
        await owner.trigger('terminal-resume', { sessionId: 'no-such-session', afterSeq: 0 });

        expect(roomEmits).toEqual([]);
        expect(stranger.ownEmits).toEqual([
            { event: 'terminal-closed', payload: { sessionId, reason: 'unknown-session' } },
        ]);
        expect(owner.ownEmits).toEqual([
            { event: 'terminal-closed', payload: { sessionId: 'no-such-session', reason: 'unknown-session' } },
        ]);
    });

    it('answers unknown-session once a closed record expired, even on a replica that still caches it', async () => {
        const { replicaB, daemon, client, sessionId } = await openAcrossReplicas();
        await daemon.trigger('terminal-closed', { sessionId, code: 0, signal: null });
        await replicaB.store.getTerminalSessionFresh(sessionId);
        // The store's 30-second TTL ran out; nothing told the peers.
        await redis.del(`terminal:session:${sessionId}`);
        roomEmits.length = 0;

        await client.trigger('terminal-resume', { sessionId, afterSeq: 0 });

        expect(roomEmits).toEqual([]);
        expect(client.ownEmits).toEqual([
            { event: 'terminal-closed', payload: { sessionId, reason: 'unknown-session' } },
        ]);
        expect(await replicaB.store.getTerminalSession(sessionId)).toBeNull();
    });

    it('a record removed on another replica is unknown here too', async () => {
        const { replicaA, client, sessionId } = await openAcrossReplicas();
        await replicaA.store.removeTerminalSession(sessionId);

        await client.trigger('terminal-resume', { sessionId, afterSeq: 0 });

        expect(client.ownEmits).toEqual([
            { event: 'terminal-closed', payload: { sessionId, reason: 'unknown-session' } },
        ]);
    });

    it('does not end a live terminal the store never recorded, when this replica still has it', async () => {
        const { client, sessionId } = await openAcrossReplicas();
        // The write at open was tolerated as a failure, so only this replica's cache knows it.
        await redis.del(`terminal:session:${sessionId}`);

        await client.trigger('terminal-resume', { sessionId, afterSeq: 3 });

        expect(client.ownEmits).toEqual([]);
        expect(roomEmits).toEqual([
            { room: 'daemon-1', event: 'terminal-resume-fwd', payload: { sessionId, afterSeq: 3 } },
        ]);
    });

    it('stays silent instead of answering unknown when the store cannot be read', async () => {
        const { sessionId } = await openAcrossReplicas();
        const replicaC = await loadReplica();
        redis.get = async () => { throw new Error('ETIMEDOUT'); };
        const back = new FakeSocket('client-2');
        replicaC.relay.terminalRelayHandler('u1', back as any);

        await back.trigger('terminal-resume', { sessionId, afterSeq: 0 });

        expect(back.ownEmits).toEqual([]);
        expect(roomEmits).toEqual([]);
    });

    it('forgets a closed record cached on a peer replica when its TTL runs out', async () => {
        vi.useFakeTimers();
        try {
            const { replicaB, daemon, sessionId } = await openAcrossReplicas();
            await daemon.trigger('terminal-closed', { sessionId, code: 0, signal: null });
            const replicaC = await loadReplica();
            expect((await replicaC.store.getTerminalSessionFresh(sessionId))?.closedAt).toEqual(expect.any(Number));
            await redis.del(`terminal:session:${sessionId}`);

            await vi.advanceTimersByTimeAsync(30_001);

            expect(await replicaC.store.getTerminalSession(sessionId)).toBeNull();
            expect(await replicaB.store.getTerminalSession(sessionId)).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('answers with the kept exit when the daemon no longer has a terminal the relay saw end', async () => {
        const { daemon, sessionId } = await openAcrossReplicas();
        await daemon.trigger('terminal-closed', { sessionId, code: 2, signal: null });
        roomEmits.length = 0;

        await daemon.trigger('terminal-closed', { sessionId, reason: 'unknown-session' });

        expect(roomEmits).toEqual([
            { room: 'client-1', event: 'terminal-closed', payload: { sessionId, code: 2, signal: null } },
        ]);
    });

    it('carries the daemon\'s unknown-session answer to the client and forgets the record', async () => {
        const { daemon, sessionId } = await openAcrossReplicas();
        await daemon.trigger('terminal-closed', { sessionId, reason: 'unknown-session' });

        expect(roomEmits).toEqual([
            { room: 'client-1', event: 'terminal-closed', payload: { sessionId, reason: 'unknown-session' } },
        ]);
        expect(redis.record(sessionId)).toBeNull();
    });
});
