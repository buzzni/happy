import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('@/storage/db', () => ({ db: { session: { findFirst: lookup } } }));
import { eventRouter } from './eventRouter';
let io: Server;
const clients: Socket[] = [];
afterEach(async () => { for (const client of clients.splice(0)) client.disconnect(); if (io) await new Promise<void>(resolve => io.close(() => resolve())); });
it('delivers authoritative ordinary events synchronously without another database dependency', () => {
    lookup.mockReset();
    const emit = vi.fn();
    eventRouter.init({ to: () => ({ emit }) } as never);
    eventRouter.emitUpdate({ userId: 'fast-owner', sessionProtection: false,
        payload: { id: '1', seq: 1, body: { t: 'new-message', sid: 'ordinary' }, createdAt: 0 } });
    expect(emit).toHaveBeenCalledOnce();
    expect(lookup).not.toHaveBeenCalled();
});
it('excludes unsupported sockets from protected update and ephemeral fan-out, preserving ordinary delivery and order', async () => {
    const http = createServer(); io = new Server(http);
    eventRouter.init(io);
    let retried = false;
    lookup.mockImplementation(async ({ where }) => {
        if (where.id === 'protected' && !retried) { retried = true; throw new Error('transient DB failure'); }
        return { piiProtection: where.id === 'protected' };
    });
    io.on('connection', socket => {
        socket.data.piiProtectionVersion = socket.handshake.auth.piiProtectionVersion;
        eventRouter.addConnection('owner', { connectionType: 'user-scoped', socket, userId: 'owner' });
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const received: unknown[][] = [[], []];
    for (const version of [undefined, 1]) {
        const client = connect(`http://127.0.0.1:${(http.address() as { port: number }).port}`, { auth: { piiProtectionVersion: version }, transports: ['websocket'] });
        const index = clients.length; clients.push(client);
        for (const event of ['update', 'ephemeral']) client.on(event, payload => received[index].push(payload));
        await new Promise<void>(resolve => client.on('connect', resolve));
    }
    const payload = (id: string, seq: number) => ({ id: String(seq), seq, body: { t: 'new-message' as const, sid: id, message: { content: 'synthetic ciphertext' } }, createdAt: 0 });
    const normal = payload('normal', 1); const protectedUpdate = payload('protected', 2);
    const ephemeral = { type: 'session-event' as const, sessionId: 'protected', title: 'private title', body: 'private body' };
    const sentinel = { id: 'end', seq: 3, body: { t: 'update-account' as const, id: 'owner' }, createdAt: 0 };
    eventRouter.emitUpdate({ userId: 'owner', payload: normal });
    eventRouter.emitUpdate({ userId: 'owner', payload: protectedUpdate });
    eventRouter.emitEphemeral({ userId: 'owner', payload: ephemeral });
    eventRouter.emitUpdate({ userId: 'owner', payload: sentinel });
    await vi.waitFor(() => expect(received[1]).toContainEqual(sentinel));
    expect(received[0]).toEqual([normal, sentinel]);
    expect(received[1]).toEqual([normal, protectedUpdate, ephemeral, sentinel]);
    expect(lookup.mock.calls.filter(([args]) => args.where.id === 'protected')).toHaveLength(2);
    lookup.mockRejectedValue(new Error('private database error'));
    eventRouter.emitUpdate({ userId: 'owner', payload: payload('unknown', 4) });
    const final = { ...sentinel, id: 'after-failure', seq: 5 };
    eventRouter.emitUpdate({ userId: 'owner', payload: final });
    await vi.waitFor(() => expect(received[1]).toContainEqual(final));
    expect(received[0]).toEqual([normal, sentinel, final]);
    expect(received[1]).toEqual([normal, protectedUpdate, ephemeral, sentinel, final]);
});

it('rejects recovered scope collisions and managed protection declarations before joining rooms', () => {
    for (const entry of [
        { connectionType: 'session-scoped', sessionId: 'protected:pii-v1', data: {} },
        { connectionType: 'machine-scoped', machineId: 'pc:pii-v1', data: {} },
        { connectionType: 'machine-scoped', machineId: 'pc', data: { managedDaemon: {}, piiProtectionVersion: 1 } },
    ]) {
        const socket = { data: entry.data, join: vi.fn(), disconnect: vi.fn() };
        eventRouter.addConnection('owner', { ...entry, socket, userId: 'owner' } as never);
        expect(socket.disconnect).toHaveBeenCalledWith(true);
        expect(socket.join).not.toHaveBeenCalled();
    }
});
