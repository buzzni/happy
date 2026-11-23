import { describe, expect, it, vi } from 'vitest';
import { inArrivalOrder, machineSocketIdentityExists } from './machineSocketAuth';

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
