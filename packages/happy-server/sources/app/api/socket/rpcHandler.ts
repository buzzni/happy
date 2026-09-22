import { createRpcLatency, parseRpcLatencyRequest, parseRpcLatencySnapshot, type RpcLatencySnapshot } from '@slopus/happy-wire';
import { log } from "@/utils/log";
import { Server, Socket } from "socket.io";
import type { RemoteSocket } from "socket.io";
import type { DefaultEventsMap } from "socket.io/dist/typed-events";
import { Counter, Histogram, register } from 'prom-client';
import { randomUUID } from 'node:crypto';
import { dispatchManagedRpc, managedRpcServer } from '@/app/api/socket/managed/managedDelivery';
import { isManagedSessionId, splitRpcMethod } from '@/app/api/socket/managed/managedRpcTarget';
import { dispatchDaemonRpc } from '@/app/api/socket/managedDaemonRpcRelay';
import { newestMachineSocket } from '@/app/events/findMachineSockets';

// RPC routing uses Socket.IO rooms. A daemon registering method M for user U
// joins room `rpc:U:M`. Callers look the daemon up cross-replica via
// io.in(room).fetchSockets() — supplied by the cluster adapter (the streams
// adapter inherits from ClusterAdapterWithHeartbeat, which implements both
// fetchSockets-cross-replica and broadcast-ack-cross-replica).
//
// No Redis keys, no TTLs, no Lua, no keep-alive refresh path. On disconnect
// Socket.IO removes the socket from all rooms automatically.

const RPC_ROOM_PREFIX = 'rpc:';
const RPC_CALL_TIMEOUT_MS = 30_000;
const RPC_PRESENCE_POLL_MS = 2_000;
// Timeouts for cross-replica fetchSockets during the reconnect grace window.
// Exponential backoff: 2s → 4s → 8s. Reduces stream pressure under load
// (fewer timed-out requests flooding the stream) while giving later attempts
// more time to succeed when Redis is slow.
const RPC_LOOKUP_FETCH_TIMEOUTS_MS = [2_000, 4_000, 8_000];
// Timeout for in-flight presence-poll fetchSockets. Must be << RPC_CALL_TIMEOUT_MS
// so a dead replica doesn't stall each poll for the full adapter heartbeatTimeout
// (10s). 500ms keeps daemon-death detection responsive (~1s).
const RPC_PRESENCE_FETCH_TIMEOUT_MS = 500;
// How long an rpc-call waits for the daemon socket to appear in the room when
// the room is empty at call time (e.g. brief daemon reconnect window). With
// exponential backoff (2s, 4s, 8s) + 200ms sleep, iterations take 2.2s, 4.2s,
// 8.2s. 15s gives ~3 iterations with increasing timeouts — fewer requests
// under load while still catching a daemon mid-reconnect.
const RPC_RECONNECT_GRACE_MS = 15_000;
const RPC_RECONNECT_POLL_MS = 200;
const MAX_RPC_RELAY_TIMEOUT_MS = 10 * 60 * 1000;

function resolveRpcRelayTimeoutMs(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return RPC_CALL_TIMEOUT_MS;
    }
    return Math.min(Math.floor(value), MAX_RPC_RELAY_TIMEOUT_MS);
}

const rpcCallCounter = new Counter({
    name: 'rpc_calls_total',
    help: 'Total RPC calls by method and outcome',
    labelNames: ['method', 'result'] as const,
    registers: [register]
});

const rpcCallDuration = new Histogram({
    name: 'rpc_call_duration_seconds',
    help: 'RPC call duration from receipt to response',
    labelNames: ['method', 'result'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30],
    registers: [register]
});

const rpcLookupRetries = new Histogram({
    name: 'rpc_lookup_retries',
    help: 'Number of grace-window polls before finding daemon (0 = instant)',
    labelNames: ['method'] as const,
    buckets: [0, 1, 2, 3, 4, 5, 6, 7],
    registers: [register]
});

const rpcFetchSocketsTimeouts = new Counter({
    name: 'rpc_fetchsockets_timeouts_total',
    help: 'Cross-replica fetchSockets timeouts by context',
    labelNames: ['context'] as const,
    registers: [register]
});

function rpcRoom(userId: string, method: string): string {
    return `${RPC_ROOM_PREFIX}${userId}:${method}`;
}

/**
 * Strip the scope prefix (machineId/sessionId) from a prefixed method name
 * to get the base method for metrics labels. Wire format: "cm9xyz123:bash" -> "bash".
 * Falls back to "unknown" if no colon separator found.
 */
function baseMethodName(prefixedMethod: string): string {
    const lastColon = prefixedMethod.lastIndexOf(':');
    return lastColon >= 0 ? prefixedMethod.substring(lastColon + 1) : prefixedMethod;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type RoomSockets = RemoteSocket<DefaultEventsMap, any>[];

/**
 * 방 조회 결과. `ok:false` 는 **모른다**는 뜻이다 — 방이 비었다는 뜻이 아니다.
 * 둘을 같은 값으로 뭉개면 호출부가 모르는 것을 안다고 답하게 된다.
 */
type RoomLookup = { ok: boolean; sockets: RoomSockets };

/**
 * fetchSockets(room) wrapped with a caller-specified timeout. Returns `[]`
 * and logs on failure (cluster-adapter request timeout, peer replica
 * unresponsive). Use RPC_LOOKUP_FETCH_TIMEOUT_MS for daemon lookups (initial
 * + grace window) and RPC_PRESENCE_FETCH_TIMEOUT_MS for in-flight presence
 * polling.
 */
async function fetchRoomSockets(io: Server, room: string, timeoutMs: number, context: 'lookup' | 'presence' = 'lookup', trace?: ReturnType<typeof createRpcLatency>): Promise<RoomLookup> {
    const end = trace?.begin('server-lookup');
    try {
        const sockets = await io.in(room).timeout(timeoutMs).fetchSockets();
        end?.('resolved', sockets.length > 0 ? 'found' : 'empty');
        return { ok: true, sockets };
    } catch (error) {
        end?.('rejected');
        rpcFetchSocketsTimeouts.inc({ context });
        log({ module: 'websocket' }, `fetchSockets failed for ${room} (timeout=${timeoutMs}ms): ${error}`);
        // `[]` 를 돌려주지 않는다. 그러면 호출부가 "조회를 못 했다" 와
        // "daemon 이 없다" 를 구분할 수 없고, 어댑터가 느릴 뿐인데 daemon 이
        // 사라졌다고 판단한다 (2026-09-18 운영 장애, 실패율 42%).
        return { ok: false, sockets: [] };
    }
}

/**
 * Poll fetchRoomSockets until it returns at least one socket OR `maxMs`
 * elapses. Uses exponential backoff on fetch timeouts (2s, 4s, 8s) to
 * reduce stream pressure when Redis is slow — fewer requests in flight
 * means less amplification of the timeout → retry → timeout spiral.
 */
async function waitForRoomMember(io: Server, room: string, maxMs: number, metricMethod: string, trace?: ReturnType<typeof createRpcLatency>): Promise<RoomLookup> {
    const deadline = Date.now() + maxMs;
    let polls = 0;
    // 한 번이라도 조회에 성공했는지. 전부 실패했다면 방이 비었는지 알 수 없다.
    let anyLookupOk = false;
    while (true) {
        const timeoutMs = RPC_LOOKUP_FETCH_TIMEOUTS_MS[Math.min(polls, RPC_LOOKUP_FETCH_TIMEOUTS_MS.length - 1)];
        const lookup = await fetchRoomSockets(io, room, timeoutMs, 'lookup', trace);
        anyLookupOk = anyLookupOk || lookup.ok;
        if (lookup.sockets.length > 0) {
            rpcLookupRetries.observe({ method: metricMethod }, polls);
            return { ok: anyLookupOk, sockets: lookup.sockets };
        }
        if (Date.now() >= deadline) {
            rpcLookupRetries.observe({ method: metricMethod }, polls);
            return { ok: anyLookupOk, sockets: lookup.sockets };
        }
        polls++;
        await sleep(RPC_RECONNECT_POLL_MS);
    }
}

export function rpcHandler(userId: string, socket: Socket, io: Server) {
    // Bounded per authenticated socket; diagnostic opt-in never gates the RPC itself.
    let diagnosticWindow = 0;
    let diagnosticCount = 0;

    socket.on('rpc-register', (data: any) => {
        try {
            const { method } = data ?? {};
            if (!method || typeof method !== 'string') {
                socket.emit('rpc-error', { type: 'register', error: 'Invalid method name' });
                return;
            }
            socket.join(rpcRoom(userId, method));
            socket.emit('rpc-registered', { method });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in rpc-register: ${error}`);
            socket.emit('rpc-error', { type: 'register', error: 'Internal error' });
        }
    });

    socket.on('rpc-unregister', (data: any) => {
        try {
            const { method } = data ?? {};
            if (!method || typeof method !== 'string') {
                socket.emit('rpc-error', { type: 'unregister', error: 'Invalid method name' });
                return;
            }
            socket.leave(rpcRoom(userId, method));
            socket.emit('rpc-unregistered', { method });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in rpc-unregister: ${error}`);
            socket.emit('rpc-error', { type: 'unregister', error: 'Internal error' });
        }
    });

    socket.on('rpc-call', async (data: any, callback: (response: any) => void) => {
        const startTime = Date.now();
        const { method, params } = data ?? {};
        let trace: ReturnType<typeof createRpcLatency> | undefined;
        let requestTrace: ReturnType<typeof parseRpcLatencyRequest>;
        try {
            if (process.env.HAPPY_RPC_LATENCY_DIAGNOSTICS === '1'
                && typeof method === 'string' && method.endsWith(':daemon-session-state')) {
                requestTrace = parseRpcLatencyRequest(data?.rpcLatency);
                const now = performance.now();
                if (now - diagnosticWindow >= 60_000) { diagnosticWindow = now; diagnosticCount = 0; }
                if (requestTrace && diagnosticCount < 10) {
                    trace = createRpcLatency(requestTrace);
                    diagnosticCount++;
                }
            }
        } catch { /* Diagnostic setup must not change dispatch. */ }
        let daemonTiming: RpcLatencySnapshot | null = null;
        let targetLocation: 'local' | 'remote' | 'unknown' = 'unknown';
        if (trace) {
            const currentTrace = trace;
            const end = currentTrace.begin('server-total');
            const originalCallback = callback;
            let completionSent = false;
            callback = (response) => {
                end(response?.ok ? 'resolved' : 'rejected');
                const rpcLatency = {
                    ...requestTrace, server: currentTrace.snapshot(), daemon: daemonTiming, target: targetLocation,
                };
                if (!completionSent && data?.rpcLatency?.completionEvent === true) {
                    completionSent = true;
                    // Send before the ACK: a preceding ACK write can make a volatile
                    // packet unwritable. Best effort, requester only, never persisted
                    // for connection recovery and never includes the RPC result.
                    try { socket.volatile.emit('rpc-latency-complete', rpcLatency); }
                    catch { /* Optional diagnostics must not prevent the original ACK. */ }
                }
                originalCallback?.({ ...response, rpcLatency });
            };
        }

        const finish = (result: string) => {
            const durationSec = (Date.now() - startTime) / 1000;
            const m = baseMethodName(method || 'unknown');
            rpcCallCounter.inc({ method: m, result });
            rpcCallDuration.observe({ method: m, result }, durationSec);
        };

        try {
            const timeoutMs = resolveRpcRelayTimeoutMs(data?.timeoutMs);

            if (!method || typeof method !== 'string') {
                finish('invalid_params');
                callback?.({ ok: false, error: 'Invalid parameters: method is required' });
                return;
            }

            // A managed session is answered only by its managed socket. The
            // legacy room below is addressed by a name a child once claimed,
            // so falling back to it when the child is offline or its grant was
            // revoked would hand that session's calls to whoever holds the
            // name now. `isManagedSessionId` is durable for exactly that
            // reason: the answer does not change when the child goes away.
            const parsed = splitRpcMethod(method);
            if (parsed && await (trace ? trace.measure('server-managed-check', () => isManagedSessionId(parsed.sessionId)) : isManagedSessionId(parsed.sessionId))) {
                const dispatched = await dispatchManagedRpc(managedRpcServer(), {
                    sessionId: parsed.sessionId,
                    accountId: userId,
                    rpcName: parsed.name,
                    requestId: randomUUID(),
                    params,
                    // The caller's deadline applies here exactly as it does on
                    // the legacy path; taking the managed branch must not mean
                    // waiting forever.
                }, undefined, { deadlineMs: timeoutMs });
                if (!dispatched.ok) {
                    // Same envelope the legacy path answers with: the caller is
                    // an ordinary account client and cannot be asked to learn a
                    // second shape because the session happens to be managed.
                    finish(dispatched.reason === 'no-target' ? 'not_available'
                        : dispatched.reason === 'timeout' ? 'timeout' : 'failed');
                    callback?.({
                        ok: false,
                        error: dispatched.error ?? 'RPC method not available',
                    });
                    return;
                }
                finish('success');
                // `result` is whatever the child acknowledged with — an opaque
                // encrypted string from its RPC handler manager. It is passed
                // through, not interpreted.
                callback?.({ ok: true, result: dispatched.result });
                return;
            }

            // 1. Find the daemon socket(s) cross-replica via the adapter.
            // If the room is empty OR fetchSockets fails (peer replica
            // unresponsive — fetchRoomSockets logs and returns []) fall
            // through to the wait-for-reconnect grace window.
            const room = rpcRoom(userId, method);
            const first = await fetchRoomSockets(io, room, RPC_LOOKUP_FETCH_TIMEOUTS_MS[0], 'lookup', trace);
            let targets = first.sockets;
            let anyLookupOk = first.ok;
            if (targets.length === 0) {
                const waited = await waitForRoomMember(io, room, RPC_RECONNECT_GRACE_MS, baseMethodName(method), trace);
                targets = waited.sockets;
                anyLookupOk = anyLookupOk || waited.ok;
            }

            if (targets.length === 0) {
                // 조회가 한 번도 성공하지 못했으면 daemon 이 없는지 **모른다**.
                // 그때 'RPC method not available' 로 답하면 호출부가 오진한다 —
                // web-ui 는 그 문구로 daemon-upgrade-required /
                // daemon-bash-not-supported 를 만든다. 사유를 갈라 준다.
                if (!anyLookupOk) {
                    finish('lookup_failed');
                    callback?.({ ok: false, error: 'RPC lookup unavailable' });
                    return;
                }
                finish('not_available');
                callback?.({ ok: false, error: 'RPC method not available' });
                return;
            }
            // Cross-replica room results have no recency ordering. A stale
            // daemon can remain registered beside its replacement, so use the
            // same server-stamped selection as terminal-open for machine RPCs.
            // Ignore foreign room members when the requested machine is present.
            // Session RPCs keep their existing selection. Never replay a sent
            // mutation on a second socket: its first execution may have succeeded.
            const machineId = method.slice(0, method.indexOf(':'));
            const machineCandidates = targets.filter((candidate) =>
                candidate.data?.clientType === 'machine-scoped'
                && candidate.data.machineId === machineId);
            const target = newestMachineSocket(machineCandidates) ?? targets[0];
            if (trace && io.sockets?.sockets) targetLocation = io.sockets.sockets.has(target.id) ? 'local' : 'remote';
            if (targets.length > 1) {
                log({ module: 'websocket', level: 'warn' },
                    `Multiple sockets in ${room} (${targets.length}); using ${machineCandidates.length > 0 ? 'newest machine socket' : 'first'} ${target.id}`);
            }

            if (target.id === socket.id) {
                finish('self_call');
                callback?.({ ok: false, error: 'Cannot call RPC on the same socket' });
                return;
            }

            /*
             * A managed runtime is dispatched through the relay, not through a
             * broadcast ack.
             *
             * `emitWithAck` on a `RemoteSocket` sends nothing from here: the
             * adapter publishes, and the replica that owns the socket delivers
             * it later without consulting anything. A check on this side would
             * therefore describe the past — a grant withdrawn during that gap
             * would not stop the request. The relay re-reads the authority on
             * the replica that actually emits, immediately before it does, with
             * the socket id fixed and no re-selection anywhere.
             */
            if (target.data?.managedDaemon) {
                const outcome = await dispatchDaemonRpc({
                    io,
                    request: {
                        requestId: randomUUID(),
                        targetSocketId: target.id,
                        method,
                        params,
                        timeoutMs,
                    },
                });
                if (outcome.ok) {
                    finish('ok');
                    callback?.({ ok: true, result: outcome.result });
                    return;
                }
                finish(outcome.reason === 'refused' ? 'not_available' : 'error');
                callback?.({ ok: false, error: 'RPC method not available' });
                return;
            }

            // 2. Single-target emit with timeout — works cross-replica via adapter.
            //
            // Race against a presence poll that aborts fast if the target leaves
            // the room. WHY: emitWithAck has no idea the target socket is dead;
            // when the daemon's pod gets killed mid-call, the cluster adapter's
            // outgoing BROADCAST request is queued waiting for a BROADCAST_ACK
            // that will never come, and the request only times out at the user-
            // set RPC_CALL_TIMEOUT_MS (30s). Heartbeat-based pod liveness
            // detection in the adapter takes ~10s and doesn't proactively
            // cancel pending broadcasts. Polling fetchSockets is the only way
            // to detect "the target socket is gone" and abort fast (~2-4s).
            //
            // Requires 2 consecutive empty polls before declaring disconnect
            // to avoid false positives from transient Redis/adapter timeouts.
            const endRelay = trace?.begin('server-relay');
            const ackPromise = target.timeout(timeoutMs)
                .emitWithAck('rpc-request', { method, params, ...(trace ? { rpcLatency: requestTrace } : {}) });

            let presenceAlive = true;
            const presencePoll = (async () => {
                let consecutiveMisses = 0;
                while (presenceAlive) {
                    await sleep(RPC_PRESENCE_POLL_MS);
                    if (!presenceAlive) return;
                    const stillThere = await fetchRoomSockets(io, room, RPC_PRESENCE_FETCH_TIMEOUT_MS, 'presence');
                    // 조회 실패는 **끊겼다는 증거가 아니다.** 예전에는 실패가
                    // `[]` 로 돌아와 miss 로 세였고, 2회 연속이면 정상 동작 중인
                    // 호출을 끊었다. 오래 걸리는 작업일수록 폴링이 많아 한 번의
                    // 오탐으로 죽는다 (2026-09-18 운영 장애).
                    if (!stillThere.ok) continue;
                    if (!stillThere.sockets.some(s => s.id === target.id)) {
                        consecutiveMisses++;
                        if (consecutiveMisses >= 2) {
                            throw new Error('RPC target disconnected');
                        }
                    } else {
                        consecutiveMisses = 0;
                    }
                }
            })();

            try {
                const response = await Promise.race([ackPromise, presencePoll]);
                endRelay?.('resolved');
                let result = response;
                if (trace && response && typeof response === 'object' && typeof response.result === 'string') {
                    // New daemon timing wraps its encrypted result; old daemons return the string directly.
                    result = response.result;
                    daemonTiming = parseRpcLatencySnapshot(response.rpcLatency, requestTrace!.id) ?? null;
                }
                finish('success');
                callback?.({ ok: true, result });
            } catch (error) {
                endRelay?.('rejected');
                const errorMsg = error instanceof Error ? error.message : 'RPC call failed';
                finish(/timeout|timed out/i.test(errorMsg) ? 'timeout' : 'failed');
                callback?.({ ok: false, error: errorMsg });
            } finally {
                presenceAlive = false;
            }
        } catch (error) {
            finish('failed');
            log({ module: 'websocket', level: 'error' }, `Error in rpc-call: ${error}`);
            callback?.({ ok: false, error: 'Internal error' });
        }
    });

    // No disconnect handler — Socket.IO removes the socket from all rooms
    // automatically, and the cluster adapter syncs the removal to other replicas.
}
