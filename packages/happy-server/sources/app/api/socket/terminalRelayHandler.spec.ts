import { beforeEach, describe, expect, it, vi } from 'vitest';

const connections = new Set<any>();

vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: {
        getConnections: () => connections,
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

function registerMachineSocket(machineId: string, socket: FakeSocket) {
    connections.add({ connectionType: 'machine-scoped', machineId, userId: 'u1', socket });
}

describe('terminalRelayHandler machine socket selection', () => {
    beforeEach(() => {
        connections.clear();
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
