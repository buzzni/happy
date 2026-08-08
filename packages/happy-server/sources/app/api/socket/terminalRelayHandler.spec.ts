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

import { terminalRelayHandler } from './terminalRelayHandler';
import { _resetTerminalSessionsForTest } from './terminalSessions';

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

    emit() {/* not used by these tests */ }

    timeout(_ms: number) {
        return {
            emitWithAck: async (event: string, payload: any) => {
                this.forwards.push({ event, payload });
                if (!this.respondsToAck) throw new Error('operation has timed out');
                return { ok: true };
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

    it('shouldDropFramesFromASocketOutsideTheSessionPair', async () => {
        const { sessionId } = await openSession();
        const stranger = new FakeSocket('stranger');
        terminalRelayHandler('u1', stranger as any);

        await stranger.trigger('terminal-frame', { sessionId, data: 'guessed' });

        expect(roomEmits).toEqual([]);
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

    it('shouldTellTheDaemonWhenTheClientSocketDisconnects', async () => {
        const { client, sessionId } = await openSession();
        await client.trigger('disconnect');

        expect(roomEmits).toEqual([
            { room: 'daemon-1', event: 'terminal-close-fwd', payload: { sessionId } },
        ]);
    });
});
