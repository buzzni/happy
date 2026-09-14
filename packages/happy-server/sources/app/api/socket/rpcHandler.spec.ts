import { describe, expect, it, vi } from 'vitest';
import { register } from 'prom-client';
import { rpcHandler } from './rpcHandler';

// These cases are about the legacy relay, so the session is not a managed one.
// The handler now asks the database that question before choosing a path, and
// answering it here keeps these cases on the path they are written for.
vi.mock('@/storage/db', () => ({
    db: { managedSessionGrant: { findFirst: async () => null } },
}));

class FakeSocket {
    connected = true;
    data: { clientType?: string; machineId?: string; connectedAt?: number } = {};
    timeoutCalls: number[] = [];
    emitted: Array<{ event: string; payload: unknown }> = [];
    handlers = new Map<string, (...args: any[]) => unknown>();

    constructor(readonly id: string) {}

    on(event: string, handler: (...args: any[]) => unknown) {
        this.handlers.set(event, handler);
    }

    emit(event: string, payload: unknown) {
        this.emitted.push({ event, payload });
    }

    timeout(ms: number) {
        this.timeoutCalls.push(ms);
        return {
            emitWithAck: vi.fn(async (_event: string, payload: unknown) => payload),
        };
    }

    async trigger(event: string, ...args: unknown[]) {
        const handler = this.handlers.get(event);
        if (!handler) throw new Error(`missing handler: ${event}`);
        return handler(...args);
    }
}

function fakeIo(targets: FakeSocket[]) {
    return {
        in: vi.fn(() => ({
            timeout: vi.fn(() => ({
                fetchSockets: vi.fn(async () => targets),
            })),
        })),
    };
}

function fakeScopedIo(targetsByRoom: Map<string, FakeSocket[]>) {
    return {
        in: vi.fn((room: string) => ({
            timeout: vi.fn(() => ({
                fetchSockets: vi.fn(async () => targetsByRoom.get(room) ?? []),
            })),
        })),
    };
}

describe('rpcHandler relay timeout', () => {
    it('uses caller-provided timeoutMs when forwarding rpc-request to the target socket', async () => {
        const caller = new FakeSocket('caller');
        const target = new FakeSocket('target');
        rpcHandler('u1', caller as any, fakeIo([target]) as any);

        const callback = vi.fn();
        await caller.trigger('rpc-call', {
            method: 'machine-1:bash',
            params: 'encrypted',
            timeoutMs: 330000,
        }, callback);

        expect(target.timeoutCalls).toEqual([330000]);
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { method: 'machine-1:bash', params: 'encrypted' },
        });
    });

    it('keeps the legacy 30s relay timeout when timeoutMs is not provided', async () => {
        const caller = new FakeSocket('caller');
        const target = new FakeSocket('target');
        rpcHandler('u1', caller as any, fakeIo([target]) as any);

        await caller.trigger('rpc-call', { method: 'machine-1:bash', params: 'encrypted' }, vi.fn());

        expect(target.timeoutCalls).toEqual([30000]);
    });
});

describe('rpcHandler user isolation', () => {
    it('does not relay a reconnect request to another user\'s target', async () => {
        vi.useFakeTimers();
        try {
            const caller = new FakeSocket('caller-user-2');
            const user1Target = new FakeSocket('target-user-1');
            const io = fakeScopedIo(new Map([
                ['rpc:user-1:session-1:mcp-reconnect', [user1Target]],
            ]));
            rpcHandler('user-2', caller as any, io as any);

            const callback = vi.fn();
            const call = caller.trigger('rpc-call', {
                method: 'session-1:mcp-reconnect',
                params: { serverName: 'argos' },
            }, callback);
            await vi.runAllTimersAsync();
            await call;

            expect(user1Target.timeoutCalls).toEqual([]);
            expect(callback).toHaveBeenCalledWith({
                ok: false,
                error: 'RPC method not available',
            });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('rpcHandler result metrics', () => {
    it('records an immediate target rejection as failed instead of timeout', async () => {
        const caller = new FakeSocket('caller');
        const target = new FakeSocket('target');
        target.timeout = vi.fn(() => ({
            emitWithAck: vi.fn(async () => { throw new Error('MCP reconnect failed'); }),
        })) as any;
        rpcHandler('u1', caller as any, fakeIo([target]) as any);

        const callback = vi.fn();
        await caller.trigger('rpc-call', {
            method: 'session-1:mcp-reconnect',
            params: 'encrypted',
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: 'MCP reconnect failed' });
        expect(await register.metrics()).toContain('rpc_calls_total{method="mcp-reconnect",result="failed"}');
    });
});

describe('rpcHandler duplicate machine connections', () => {
    it.each([false, true])('uses the newest registered machine connection regardless of replica order (reversed=%s)', async (reversed) => {
        const caller = new FakeSocket('caller');
        const stale = new FakeSocket('stale');
        stale.data = { clientType: 'machine-scoped', machineId: 'machine-1', connectedAt: 100 };
        const current = new FakeSocket('current');
        current.data = { clientType: 'machine-scoped', machineId: 'machine-1', connectedAt: 200 };
        // Still in the adapter room, but no longer able to answer the request.
        const staleEmit = vi.fn(async () => { throw new Error('operation has timed out'); });
        stale.timeout = vi.fn(() => ({ emitWithAck: staleEmit }));
        const currentEmit = vi.fn(async () => 'encrypted-result');
        current.timeout = vi.fn(() => ({ emitWithAck: currentEmit }));
        rpcHandler('u1', caller as any, fakeIo(reversed ? [current, stale] : [stale, current]) as any);
        const callback = vi.fn();
        await caller.trigger('rpc-call', { method: 'machine-1:bash', params: 'encrypted-create-worktree' }, callback);
        expect(callback).toHaveBeenCalledExactlyOnceWith({ ok: true, result: 'encrypted-result' });
        expect(currentEmit).toHaveBeenCalledExactlyOnceWith('rpc-request', {
            method: 'machine-1:bash', params: 'encrypted-create-worktree',
        });
        expect(stale.timeout).not.toHaveBeenCalled();
        expect(staleEmit).not.toHaveBeenCalled();
    });

    it.each([
        { clientType: 'session-scoped', connectedAt: 300 },
        { clientType: 'machine-scoped', machineId: 'other-machine', connectedAt: 300 },
        {},
    ])('ignores a foreign room member when the requested machine is registered (%j)', async (foreignData) => {
        const caller = new FakeSocket('caller');
        const foreign = new FakeSocket('foreign');
        foreign.data = foreignData;
        const current = new FakeSocket('current');
        current.data = { clientType: 'machine-scoped', machineId: 'machine-1', connectedAt: 200 };
        rpcHandler('u1', caller as any, fakeIo([foreign, current]) as any);
        const callback = vi.fn();
        await caller.trigger('rpc-call', { method: 'machine-1:bash', params: 'encrypted' }, callback);
        expect(current.timeoutCalls).toEqual([30000]);
        expect(foreign.timeoutCalls).toEqual([]);
        expect(callback).toHaveBeenCalledExactlyOnceWith({
            ok: true, result: { method: 'machine-1:bash', params: 'encrypted' },
        });
    });

    it('does not replay a timed-out mutation on another connection', async () => {
        const caller = new FakeSocket('caller');
        const stale = new FakeSocket('stale');
        stale.data = { clientType: 'machine-scoped', machineId: 'machine-1', connectedAt: 100 };
        const current = new FakeSocket('current');
        current.data = { clientType: 'machine-scoped', machineId: 'machine-1', connectedAt: 200 };
        const emit = vi.fn(async () => { throw new Error('operation has timed out'); });
        current.timeout = vi.fn(() => ({ emitWithAck: emit }));
        rpcHandler('u1', caller as any, fakeIo([stale, current]) as any);
        const callback = vi.fn();
        await caller.trigger('rpc-call', { method: 'machine-1:spawn-happy-session', params: 'encrypted' }, callback);
        expect(callback).toHaveBeenCalledExactlyOnceWith({ ok: false, error: 'operation has timed out' });
        expect(emit).toHaveBeenCalledTimes(1);
        expect(stale.timeoutCalls).toEqual([]);
    });

    it('preserves session RPC selection when candidates are not machine connections', async () => {
        const caller = new FakeSocket('caller');
        const first = new FakeSocket('first');
        first.data = { clientType: 'session-scoped', connectedAt: 100 };
        const second = new FakeSocket('second');
        second.data = { clientType: 'session-scoped', connectedAt: 200 };
        rpcHandler('u1', caller as any, fakeIo([first, second]) as any);
        await caller.trigger('rpc-call', { method: 'session-1:permission', params: 'encrypted' }, vi.fn());
        expect(first.timeoutCalls).toEqual([30000]);
        expect(second.timeoutCalls).toEqual([]);
    });
});
