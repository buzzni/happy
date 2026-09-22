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

/*
 * 2026-09-18 운영 장애. happy-server 가 OOM 으로 재시작한 뒤 레플리카 간
 * `fetchSockets` 조회가 계속 시한을 넘겼고, daemon RPC 실패율이 42% 까지 올랐다
 * (success 5,670 / timeout 2,480 / not_available 1,698, 1시간 기준).
 *
 * `fetchRoomSockets` 가 실패를 `[]` 로 뭉갠 것이 증상을 키웠다. 호출부는
 * 「조회가 실패했다」와 「daemon 이 없다」를 구분할 수 없어, 어댑터가 느릴 뿐인데
 * daemon 이 사라졌다고 판단했다 (CLAUDE.md §1.13 「조용한 실패를 만들지 않는다」).
 *
 * 여기서 고정하는 것은 그 구분이다. 모르는 것을 안다고 답하지 않는다.
 */
class HangingSocket extends FakeSocket {
    resolveAck: ((value: unknown) => void) | null = null;

    timeout(ms: number) {
        this.timeoutCalls.push(ms);
        return {
            emitWithAck: vi.fn(() => new Promise((resolve) => { this.resolveAck = resolve; })),
        };
    }
}

/** 첫 조회는 성공시키고, 그 뒤 생존 확인 조회부터 어댑터가 죽은 척한다. */
function fakeIoFailingAfterFirstLookup(target: FakeSocket) {
    let calls = 0;
    return {
        in: vi.fn(() => ({
            timeout: vi.fn(() => ({
                fetchSockets: vi.fn(async () => {
                    calls += 1;
                    if (calls === 1) return [target];
                    throw new Error('timeout reached: missing 1 responses');
                }),
            })),
        })),
    };
}

describe('rpcHandler adapter lookup failures', () => {
    /* 생존 확인 조회가 실패한 것은 daemon 이 끊겼다는 증거가 아니다. 예전에는
       실패가 `[]` 로 돌아와 miss 로 세였고, 2회 연속이면 **정상 동작 중인**
       호출을 'RPC target disconnected' 로 끊었다. 오래 걸리는 작업일수록 폴링
       횟수가 많아 한 번만 오탐해도 죽는다. */
    it('does not abort a live call when the presence lookup itself fails', async () => {
        vi.useFakeTimers();
        try {
            const caller = new FakeSocket('caller');
            const target = new HangingSocket('target');
            rpcHandler('u1', caller as any, fakeIoFailingAfterFirstLookup(target) as any);

            const callback = vi.fn();
            const call = caller.trigger('rpc-call', {
                method: 'machine-1:writeFile',
                params: 'encrypted',
            }, callback);

            // 생존 확인은 2초 간격이다. 두 번 돌려 옛 코드가 끊던 지점을 지난다.
            await vi.advanceTimersByTimeAsync(5_000);
            expect(callback).not.toHaveBeenCalled();

            target.resolveAck?.('daemon-result');
            await vi.runAllTimersAsync();
            await call;

            expect(callback).toHaveBeenCalledWith({ ok: true, result: 'daemon-result' });
        } finally {
            vi.useRealTimers();
        }
    });

    /* 조회가 한 번도 성공하지 못했으면 daemon 이 없는지 알 수 없다.
       「RPC method not available」로 답하면 호출부가 daemon 이 낡았다거나 그
       기능이 없다고 오진한다 — web-ui 는 실제로 그 문구로
       `daemon-upgrade-required` / `daemon-bash-not-supported` 를 만든다. */
    it('separates a failed lookup from a genuinely absent daemon', async () => {
        vi.useFakeTimers();
        try {
            const caller = new FakeSocket('caller');
            const io = {
                in: vi.fn(() => ({
                    timeout: vi.fn(() => ({
                        fetchSockets: vi.fn(async () => {
                            throw new Error('timeout reached: missing 1 responses');
                        }),
                    })),
                })),
            };
            rpcHandler('u1', caller as any, io as any);

            const callback = vi.fn();
            const call = caller.trigger('rpc-call', {
                method: 'machine-1:bash',
                params: 'encrypted',
            }, callback);
            await vi.runAllTimersAsync();
            await call;

            const [[response]] = callback.mock.calls;
            expect(response.ok).toBe(false);
            expect(response.error).not.toBe('RPC method not available');
        } finally {
            vi.useRealTimers();
        }
    });

    /* 방이 정말 비어 있으면 예전 문구를 그대로 쓴다 — 이쪽은 오진이 아니다. */
    it('still reports an empty room as method not available', async () => {
        vi.useFakeTimers();
        try {
            const caller = new FakeSocket('caller');
            rpcHandler('u1', caller as any, fakeIo([]) as any);

            const callback = vi.fn();
            const call = caller.trigger('rpc-call', {
                method: 'machine-1:bash',
                params: 'encrypted',
            }, callback);
            await vi.runAllTimersAsync();
            await call;

            expect(callback).toHaveBeenCalledWith({
                ok: false,
                error: 'RPC method not available',
            });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('opt-in native RPC timing', () => {
    const rpcLatency = { version: 1, id: '11111111-1111-4111-8111-111111111111' };
    it('correlates server phases, unwraps new daemon ACKs and preserves the relay timeout', async () => {
        vi.stubEnv('HAPPY_RPC_LATENCY_DIAGNOSTICS', '1');
        try {
            const caller = new FakeSocket('caller');
            const target = new FakeSocket('target');
            const daemon = { ...rpcLatency, spans: [{ stage: 'daemon-handler', durationMs: 1, outcome: 'resolved' }], droppedSpans: 0, clockFailures: 0 };
            const emit = vi.fn(async () => ({ result: 'encrypted-result', rpcLatency: daemon }));
            target.timeout = vi.fn(() => ({ emitWithAck: emit }));
            rpcHandler('u1', caller as any, fakeIo([target]) as any);
            const callback = vi.fn();
            await caller.trigger('rpc-call', { method: 'machine-1:daemon-session-state', params: 'encrypted', rpcLatency }, callback);
            expect(emit).toHaveBeenCalledExactlyOnceWith('rpc-request', { method: 'machine-1:daemon-session-state', params: 'encrypted', rpcLatency });
            expect(target.timeout).toHaveBeenCalledWith(30000);
            const reply = callback.mock.calls[0][0];
            expect(reply.result).toBe('encrypted-result');
            expect(reply.rpcLatency.id).toBe(rpcLatency.id);
            expect(reply.rpcLatency.daemon).toEqual(daemon);
            expect(reply.rpcLatency.server.spans.map((s: any) => s.stage)).toEqual(['server-total', 'server-managed-check', 'server-lookup', 'server-relay']);
            expect(JSON.stringify(reply.rpcLatency)).not.toMatch(/machine-1|encrypted|u1|params/);
        } finally { vi.unstubAllEnvs(); }
    });
    it('accepts old daemon strings, caps requests and ignores tracing when disabled', async () => {
        vi.stubEnv('HAPPY_RPC_LATENCY_DIAGNOSTICS', '1');
        try {
            const caller = new FakeSocket('caller');
            const target = new FakeSocket('target');
            const emit = vi.fn(async (_event: string, _payload: unknown) => 'old-encrypted-result');
            target.timeout = vi.fn(() => ({ emitWithAck: emit }));
            rpcHandler('u1', caller as any, fakeIo([target]) as any);
            const callback = vi.fn();
            for (let i = 0; i < 11; i++) await caller.trigger('rpc-call', { method: 'machine-1:daemon-session-state', params: 'encrypted', rpcLatency }, callback);
            expect(callback.mock.calls[0][0]).toMatchObject({ ok: true, result: 'old-encrypted-result', rpcLatency: { daemon: null } });
            expect(callback.mock.calls[10][0]).toEqual({ ok: true, result: 'old-encrypted-result' });
            expect(emit).toHaveBeenCalledTimes(11);
            expect(emit.mock.calls[10][1]).not.toHaveProperty('rpcLatency');
            vi.stubEnv('HAPPY_RPC_LATENCY_DIAGNOSTICS', '0');
            await caller.trigger('rpc-call', { method: 'machine-1:daemon-session-state', params: 'encrypted', rpcLatency }, callback);
            expect(callback.mock.calls[11][0]).toEqual({ ok: true, result: 'old-encrypted-result' });
        } finally { vi.unstubAllEnvs(); }
    });
});

it('records failed initial lookup then successful retry without replaying the native call', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPY_RPC_LATENCY_DIAGNOSTICS', '1');
    try {
        const caller = new FakeSocket('caller');
        const target = new FakeSocket('target');
        const emit = vi.fn(async () => 'encrypted-result');
        target.timeout = vi.fn(() => ({ emitWithAck: emit }));
        const fetchSockets = vi.fn()
            .mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(new Error('lookup timeout')), 2000)))
            .mockResolvedValue([target]);
        const io = { in: () => ({ timeout: () => ({ fetchSockets }) }), sockets: { sockets: new Map([['target', target]]) } };
        rpcHandler('u1', caller as any, io as any);
        const callback = vi.fn();
        const rpcLatency = { version: 1, id: '11111111-1111-4111-8111-111111111111' };
        const pending = caller.trigger('rpc-call', { method: 'machine-1:daemon-session-state', params: 'encrypted', rpcLatency }, callback);
        await vi.advanceTimersByTimeAsync(2000);
        await pending;
        const reply = callback.mock.calls[0][0];
        expect(reply).toMatchObject({ ok: true, result: 'encrypted-result', rpcLatency: { target: 'local' } });
        expect(reply.rpcLatency.server.spans.filter((s: any) => s.stage === 'server-lookup').map((s: any) => [s.outcome, s.lookupResult])).toEqual([['rejected', undefined], ['resolved', 'found']]);
        expect(fetchSockets).toHaveBeenCalledTimes(2);
        expect(emit).toHaveBeenCalledTimes(1);
        // ACK completed before the 2s presence poll, which must not delay delivery.
        expect(callback).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
});

it.each([
    ['machine-1:bash', { version: 1, id: '11111111-1111-4111-8111-111111111111' }],
    ['machine-1:daemon-session-state', { version: 1, id: 'private-session' }],
])('ignores diagnostics for ineligible method or invalid ID: %s', async (method, rpcLatency) => {
    vi.stubEnv('HAPPY_RPC_LATENCY_DIAGNOSTICS', '1');
    try {
        const caller = new FakeSocket('caller');
        const target = new FakeSocket('target');
        const emit = vi.fn(async (_event: string, _payload: unknown) => 'encrypted');
        target.timeout = vi.fn(() => ({ emitWithAck: emit }));
        rpcHandler('u1', caller as any, fakeIo([target]) as any);
        const callback = vi.fn();
        await caller.trigger('rpc-call', { method, params: 'input', rpcLatency }, callback);
        expect(emit).toHaveBeenCalledExactlyOnceWith('rpc-request', { method, params: 'input' });
        expect(callback).toHaveBeenCalledExactlyOnceWith({ ok: true, result: 'encrypted' });
    } finally { vi.unstubAllEnvs(); }
});
