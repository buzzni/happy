import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('@/storage/db', () => ({ db: { session: { findFirst: lookup } } }));
import { eventRouter, sessionStreamWatchRoom } from './eventRouter';
import { userScopedRoom } from './hasActiveUserScopedSocket';

/*
 * aplus-dev-studio specs/agent-app-api — a server that runs an agent-app turn reads the answer as it is written.
 * Its socket is transport-only: in the user-scoped room it would count as a human watching and hold back the
 * account's push notifications. It watches the one session instead.
 */

let io: Server;
const clients: Socket[] = [];
afterEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();
    if (io) await new Promise<void>(resolve => io.close(() => resolve()));
});

it('keeps a stream watcher out of the user-scoped room, so it is never a human watching', () => {
    const joined: string[] = [];
    const socket = { join: (room: string) => { joined.push(room); }, data: {} } as any;

    eventRouter.watchSessionStream('u1', socket, 's1');

    expect(joined).toEqual([sessionStreamWatchRoom('u1', 's1')]);
    expect(joined).not.toContain(userScopedRoom('u1'));
});

it('delivers a session stream to human clients and to watchers of that session only', async () => {
    lookup.mockResolvedValue({ piiProtection: false });
    const http = createServer(); io = new Server(http);
    eventRouter.init(io);
    io.on('connection', socket => {
        const transportOnly = socket.handshake.auth.transportOnly === true;
        eventRouter.addConnection('owner', { connectionType: 'user-scoped', socket, userId: 'owner', ...(transportOnly ? { transportOnly: true } : {}) });
        if (socket.handshake.auth.watch) eventRouter.watchSessionStream('owner', socket, socket.handshake.auth.watch);
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    const received: Record<string, unknown[]> = {};
    for (const [name, auth] of [
        ['human', {}],
        ['watcher', { transportOnly: true, watch: 's1' }],
        ['otherWatcher', { transportOnly: true, watch: 's2' }],
        ['transport', { transportOnly: true }],
    ] as const) {
        const client = connect(`http://127.0.0.1:${port}`, { auth, transports: ['websocket'] });
        clients.push(client);
        received[name] = [];
        client.on('ephemeral', payload => received[name].push(payload));
        await new Promise<void>(resolve => client.on('connect', resolve));
    }

    const frame = { type: 'stream' as const, id: 's1', time: 1, data: 'ciphertext' };
    eventRouter.emitEphemeral({ userId: 'owner', payload: frame, recipientFilter: { type: 'session-stream', sessionId: 's1' } });
    const sentinel = { type: 'stream' as const, id: 's2', time: 2, data: 'ciphertext' };
    eventRouter.emitEphemeral({ userId: 'owner', payload: sentinel, recipientFilter: { type: 'session-stream', sessionId: 's2' } });

    await vi.waitFor(() => expect(received.otherWatcher).toEqual([sentinel]));
    await vi.waitFor(() => expect(received.human).toEqual([frame, sentinel]));
    expect(received.watcher).toEqual([frame]);
    expect(received.transport).toEqual([]);
});

it('delivers an update meant for stream watchers to the watchers of that session only', async () => {
    // The CLI writes the MCP server status into the session metadata; an agent-app turn fails on it (specs/agent-app-api R9).
    lookup.mockResolvedValue({ piiProtection: false });
    const http = createServer(); io = new Server(http);
    eventRouter.init(io);
    io.on('connection', socket => {
        const transportOnly = socket.handshake.auth.transportOnly === true;
        eventRouter.addConnection('owner', { connectionType: 'user-scoped', socket, userId: 'owner', ...(transportOnly ? { transportOnly: true } : {}) });
        if (socket.handshake.auth.watch) eventRouter.watchSessionStream('owner', socket, socket.handshake.auth.watch);
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    const received: Record<string, unknown[]> = {};
    for (const [name, auth] of [
        ['human', {}],
        ['watcher', { transportOnly: true, watch: 's1' }],
        ['otherWatcher', { transportOnly: true, watch: 's2' }],
    ] as const) {
        const client = connect(`http://127.0.0.1:${port}`, { auth, transports: ['websocket'] });
        clients.push(client);
        received[name] = [];
        client.on('update', payload => received[name].push(payload));
        await new Promise<void>(resolve => client.on('connect', resolve));
    }

    const update = { id: 'u1', seq: 1, body: { t: 'update-session' as const, id: 's1', metadata: { value: 'sealed', version: 2 } }, createdAt: 1 };
    eventRouter.emitUpdate({ userId: 'owner', payload: update, recipientFilter: { type: 'session-stream-watchers', sessionId: 's1' } });
    const sentinel = { id: 'u2', seq: 2, body: { t: 'update-session' as const, id: 's2', metadata: { value: 'sealed', version: 2 } }, createdAt: 2 };
    eventRouter.emitUpdate({ userId: 'owner', payload: sentinel, recipientFilter: { type: 'session-stream-watchers', sessionId: 's2' } });

    await vi.waitFor(() => expect(received.otherWatcher).toEqual([sentinel]));
    expect(received.watcher).toEqual([update]);
    // A human client already gets the same update through the session's interested rooms.
    expect(received.human).toEqual([]);
});
