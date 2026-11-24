import { describe, expect, it, vi } from 'vitest';
import { inArrivalOrder, machineSocketIdentityExists, workMachinePacketGuard } from './machineSocketAuth';

describe('machineSocketIdentityExists', () => {
    it('binds the verified token account to the handshake machine id', async () => {
        const findFirst = vi.fn(async () => ({ id: 'machine-1' }));
        await expect(machineSocketIdentityExists({ machine: { findFirst } } as never, 'account-1', 'machine-1'))
            .resolves.toBe(true);
        expect(findFirst).toHaveBeenCalledWith({
            where: { accountId: 'account-1', id: 'machine-1', workMachineExecution: { is: null } },
            select: { id: true },
        });
    });

    it('rejects an unregistered or cross-account machine id', async () => {
        const findFirst = vi.fn(async () => null);
        await expect(machineSocketIdentityExists({ machine: { findFirst } } as never, 'account-1', 'foreign-machine'))
            .resolves.toBe(false);
    });
});

describe('inArrivalOrder', () => {
    it('dispatches packets over a real socket in the order they arrived when an earlier check answers last', async () => {
        const { Server } = await import('socket.io');
        const { io: connect } = await import('socket.io-client');
        const { createServer } = await import('node:http');
        const http = createServer();
        const server = new Server(http);
        const received: number[] = [];
        const done = new Promise<void>(resolve => {
            server.on('connection', socket => {
                // The first lookup is slow, as on a busy pool connection.
                let checks = 0;
                socket.use(inArrivalOrder(([, seq], next) => {
                    setTimeout(() => next(seq === 3 ? new Error('refused') : undefined), checks++ === 0 ? 30 : 1);
                }));
                socket.on('proxy-ws-data', (seq: number) => {
                    received.push(seq);
                    if (received.length === 19) resolve();
                });
            });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const client = connect(`http://127.0.0.1:${(http.address() as { port: number }).port}`, { transports: ['websocket'] });
        try {
            await new Promise<void>(resolve => client.once('connect', resolve));
            for (let seq = 0; seq < 20; seq++) client.emit('proxy-ws-data', seq);
            await done;
            expect(received).toEqual([0, 1, 2, ...Array.from({ length: 16 }, (_, i) => i + 4)]);
        } finally {
            client.disconnect();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
});

describe('workMachinePacketGuard', () => {
    // An enrolled machine: the account's legacy bearer may no longer reach it.
    const protectedMachineDb = {
        workMachineExecution: { findFirst: vi.fn(async () => ({ machineId: 'machine-1', frozenAt: null })) },
        session: { findFirst: vi.fn(async () => null) },
    } as never;

    async function withGuardedServer(
        context: Parameters<typeof workMachinePacketGuard>[1],
        run: (client: import('socket.io-client').Socket, handled: string[]) => Promise<void>,
        db = protectedMachineDb,
    ) {
        const { Server } = await import('socket.io');
        const { io: connect } = await import('socket.io-client');
        const { createServer } = await import('node:http');
        const http = createServer();
        const server = new Server(http);
        const handled: string[] = [];
        server.on('connection', socket => {
            socket.on('error', () => { /* a refused packet is reported here */ });
            socket.use(workMachinePacketGuard(db, context, () => {}));
            socket.on('rpc-call', (data: { method: string }, callback: (response: unknown) => void) => {
                handled.push(data.method);
                callback({ ok: true, result: 'ran' });
            });
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const client = connect(`http://127.0.0.1:${(http.address() as { port: number }).port}`, { transports: ['websocket'] });
        try {
            await new Promise<void>(resolve => client.once('connect', resolve));
            await run(client, handled);
        } finally {
            client.disconnect();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    }

    it('answers an account-token rpc-call to a protected machine at once with work-machine-credential-required', async () => {
        await withGuardedServer({ accountId: 'account-1', socketMachineId: undefined, claims: null }, async (client, handled) => {
            // A dropped packet would only surface as this ack timing out.
            const response = await client.timeout(2_000).emitWithAck('rpc-call', { method: 'machine-1:bash', params: 'sealed' });

            expect(response).toEqual({ ok: false, error: 'work-machine-credential-required' });
            expect(handled).toEqual([]);
        });
    });

    it('answers a refused rpc-call from a work machine browser with an explicit refusal', async () => {
        await withGuardedServer({
            accountId: 'account-1', socketMachineId: undefined, socketSessionId: 'session-1', workMachineBrowser: true, claims: null,
        }, async (client, handled) => {
            const response = await client.timeout(2_000).emitWithAck('rpc-call', { method: 'machine-1:bash', params: 'sealed' });

            expect(response).toEqual({ ok: false, error: 'work-machine-execution-not-authorized' });
            expect(handled).toEqual([]);
        });
    });

    it('answers an rpc-call whose authority lookup failed instead of dropping it', async () => {
        const failingDb = {
            workMachineExecution: { findFirst: vi.fn(async () => { throw new Error('db down'); }) },
            session: { findFirst: vi.fn(async () => null) },
        } as never;
        await withGuardedServer({ accountId: 'account-1', socketMachineId: undefined, claims: null }, async (client, handled) => {
            const response = await client.timeout(2_000).emitWithAck('rpc-call', { method: 'machine-1:bash', params: 'sealed' });

            expect(response).toEqual({ ok: false, error: 'work-machine-execution-lookup-failed' });
            expect(handled).toEqual([]);
        }, failingDb);
    });

    it('lets a work machine browser rpc-call through to its handler', async () => {
        await withGuardedServer({
            accountId: 'account-1', socketMachineId: undefined, workMachineBrowser: true, claims: null,
        }, async (client, handled) => {
            const response = await client.timeout(2_000).emitWithAck('rpc-call', { method: 'machine-1:bash', params: 'sealed' });

            expect(response).toEqual({ ok: true, result: 'ran' });
            expect(handled).toEqual(['machine-1:bash']);
        });
    });
});
