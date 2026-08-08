#!/usr/bin/env node
/**
 * Connection state recovery smoke test (aplus-dev-studio
 * specs/websocket-connection-state-recovery Phase 3).
 *
 * `socket.ts` has `connectionStateRecovery` commented out, citing
 * `deploy/integration-tests/missed-events.mjs` as prior verification. That
 * file does not exist in this repo (`git ls-files` returns 0 matches) — this
 * script is the replacement, and it is meant to run and pass BEFORE Phase 4
 * (turning the feature on in socket.ts) rather than after.
 *
 * WHY A STANDALONE HARNESS INSTEAD OF THE REAL happy-server
 * -----------------------------------------------------------
 * The mechanism under test — Socket.IO's connectionStateRecovery — lives
 * entirely in socket.io + the Redis streams adapter (persistSession /
 * restoreSession, both backed by the same Redis every replica shares). It
 * does not touch happy-server's auth, routes, or business logic, so a
 * minimal harness that mirrors the adapter config exercises the real
 * mechanism without needing a deployed cluster. Two in-process Socket.IO
 * servers ("replica A", "replica B") share one real Redis via
 * @socket.io/redis-streams-adapter — the same package and adapter used by
 * socket.ts.
 *
 * WHAT "CROSS-REPLICA" MEANS HERE
 * --------------------------------
 * Recovery is decided by socket.io core (Socket constructor, socket.js) by
 * calling `adapter.restoreSession(pid, offset)` — Redis-backed, so it does
 * not care which physical server instance handles the reconnect. The client
 * carries `_pid`/`_lastOffset` on the Socket instance itself (socket.io-
 * client, socket.js), not the transport-level connection. To simulate a
 * real client that reconnects through an ingress and lands on a different
 * pod, this script manually copies `_pid`/`_lastOffset` from a socket
 * connected to replica A onto a fresh socket pointed at replica B before
 * that socket's first connect — its CONNECT packet then carries the same
 * `{pid, offset}} a same-replica reconnect would send, and B's
 * restoreSession (shared Redis) has to succeed on its own for `recovered`
 * to come back true. This is the one place this script pokes at library
 * internals (`_pid`/`_lastOffset` are plain instance properties, not `#`-
 * private, so this is not fragile in the way true-private access would be)
 * — everything else drives the public client/server API.
 *
 * DISCONNECT REASON MATTERS: socket.io only persists a session for
 * `RECOVERABLE_DISCONNECT_REASONS` (transport close/error, ping timeout,
 * forced/server-shutdown close) — NOT a graceful `socket.disconnect()`. A
 * pod dying (SIGKILL, OOM, node crash) surfaces as "transport close" or
 * "transport error" on the server side, so this script destroys the
 * server-side raw socket rather than calling `.disconnect()`, to match what
 * actually happens during a rollout.
 *
 * JUDGEMENT PRINCIPLE (inherited from smoke-cross-placement.mjs):
 * "could not check" is not PASS. A check that cannot execute is FAIL, not
 * SKIP-and-continue, unless explicitly gated behind a documented precondition.
 *
 * USAGE
 *   node smoke-recovery.mjs [redisUrl]
 *   (default redisUrl: redis://127.0.0.1:6379 — point this at a real Redis,
 *   e.g. `kubectl port-forward` to a dev cluster's redis-replication pod, or
 *   a local `redis-server`. Uses an isolated stream name; never touches the
 *   real `socket.io` stream a running happy-server relies on.)
 */

import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';

// pnpm keeps node_modules strict and `specs/` is not a workspace package, so
// resolve each dependency from whichever real package actually declares it
// (mirrors specs/relay-cross-replica-routing/smoke-cross-placement.mjs).
// `socket.io` (server) lives in happy-server; `socket.io-client` lives in
// happy-cli — neither package alone has both, so each name is resolved
// independently rather than requiring one base to satisfy every import.
const PACKAGE_BASES = [
    '../../packages/happy-server/package.json',
    '../../packages/happy-cli/package.json',
    '../../package.json',
];
function loadDep(name) {
    for (const base of PACKAGE_BASES) {
        try {
            return createRequire(new URL(base, import.meta.url))(name);
        } catch { /* try the next base */ }
    }
    throw new Error(`'${name}' 를 찾을 수 없다. vendor/happy 에서 \`pnpm install\` 을 먼저 실행하라.`);
}
const { Server } = loadDep('socket.io');
const { io: ioClient } = loadDep('socket.io-client');
const { createAdapter } = loadDep('@socket.io/redis-streams-adapter');
const { Redis } = loadDep('ioredis');

const REDIS_URL = process.argv[2] ?? 'redis://127.0.0.1:6379';
const STREAM_NAME = 'smoke-connection-state-recovery-stream';
const SESSION_KEY_PREFIX = 'smoke:csr:session:';

let failed = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.log(`  FAIL  ${m}`); failed++; };
const info = (m) => console.log(`        ${m}`);
const section = (m) => console.log(`\n== ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One "replica": an HTTP server + Socket.IO server on the Redis streams
 * adapter, configured to mirror socket.ts's real settings closely enough
 * for this test (path, transports, connectionStateRecovery) without
 * importing happy-server itself.
 */
async function makeReplica(label, { maxDisconnectionDuration }) {
    const redisClient = new Redis(REDIS_URL);
    redisClient.on('error', () => { /* smoke script owns retries via exit code, not ioredis reconnect noise */ });
    const httpServer = createServer();
    const io = new Server(httpServer, {
        path: '/v1/updates',
        transports: ['websocket'],
        connectionStateRecovery: { maxDisconnectionDuration },
    });
    io.adapter(createAdapter(redisClient, {
        streamName: STREAM_NAME,
        sessionKeyPrefix: SESSION_KEY_PREFIX,
        maxLen: 10_000,
    }));
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = httpServer.address().port;
    return {
        label, io, redisClient, port,
        url: `http://127.0.0.1:${port}`,
        async close() {
            io.close();
            redisClient.disconnect();
        },
    };
}

/** Destroys the server-side raw socket for a client — the "pod got SIGKILLed
 * mid-connection" case, which surfaces as a RECOVERABLE disconnect reason
 * (transport close/error) unlike a graceful socket.disconnect(). */
function killClientTransport(replica, clientSocketId) {
    const engineSocket = replica.io.of('/').sockets.get(clientSocketId)?.conn;
    if (!engineSocket) throw new Error(`no engine.io transport found for ${clientSocketId} on ${replica.label}`);
    const ws = engineSocket.transport.socket; // `ws` package WebSocket, not a raw net.Socket
    if (typeof ws?.terminate === 'function') {
        ws.terminate(); // abrupt — no close handshake, surfaces as "transport error"/"transport close"
    } else if (typeof ws?.destroy === 'function') {
        ws.destroy();
    } else {
        throw new Error('engine.io websocket transport has neither terminate() nor destroy() — API changed?');
    }
}

/** Points a fresh client Socket at `toReplica`, carrying over the CSR
 * session identity from `fromSocket` so the CONNECT packet looks like a
 * genuine reconnect that happened to land on a different replica. */
function reconnectAcrossReplica(fromSocket, toReplica) {
    const next = ioClient(toReplica.url, {
        path: '/v1/updates',
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
    });
    // See file header: these are plain instance properties on the client
    // Socket (socket.io-client's socket.js), set here before the manager's
    // first `open` so the CONNECT packet already includes {pid, offset}.
    next._pid = fromSocket._pid;
    next._lastOffset = fromSocket._lastOffset;
    return next;
}

/**
 * socket.io-client only learns the stream offset to resume from as a side
 * effect of RECEIVING an event while connected (socket.js emitEvent: `if
 * (this._pid && args.length && typeof args[...] === "string") this._lastOffset
 * = args[...]`). A socket that disconnects before ever receiving a single
 * event has `_lastOffset === undefined`, and `restoreSession` rejects any
 * offset that doesn't match `/^[0-9]+-[0-9]+$/` — so recovery is impossible
 * for a connection that saw zero traffic, even with a healthy session.
 * That's correct/safe behavior, not a bug, but it means a test that kills
 * the transport immediately after connect (before any event) is testing an
 * artificial case no real session hits — happy-server's sockets constantly
 * receive `update`/`ephemeral` traffic. Emit one throwaway event and wait
 * for the client to see it, so `_lastOffset` is populated the way a real
 * session's always would be before this script asserts anything about
 * recovery.
 */
async function primeOffset(replica, room, client) {
    const seen = once(client, 'primer');
    replica.io.to(room).emit('primer', {});
    await seen;
}

async function waitConnect(socket, timeoutMs = 8000) {
    if (socket.connected) return;
    await Promise.race([
        once(socket, 'connect'),
        sleep(timeoutMs).then(() => { throw new Error('connect timeout'); }),
    ]);
}

async function main() {
    console.log(`connectionStateRecovery 스모크 — redis=${REDIS_URL}`);

    section('0. 전제 — Redis 도달 가능');
    const preflight = new Redis(REDIS_URL, { lazyConnect: true, retryStrategy: () => null });
    preflight.on('error', () => { /* surfaced via the catch below, not ioredis's own noisy default log */ });
    try {
        await preflight.connect();
        await preflight.ping();
        pass('Redis PING 성공');
    } catch (e) {
        fail(`Redis 접속 실패: ${e.message} — 이후 검사는 실행할 수 없다`);
        preflight.disconnect();
        printSummaryAndExit();
        return;
    } finally {
        preflight.disconnect();
    }

    // Clean slate: this is an isolated stream/session prefix, never the real
    // happy-server `socket.io` stream, but previous failed runs could leave
    // entries behind.
    const cleanup = new Redis(REDIS_URL);
    await cleanup.del(STREAM_NAME);
    const staleSessionKeys = await cleanup.keys(`${SESSION_KEY_PREFIX}*`);
    if (staleSessionKeys.length) await cleanup.del(...staleSessionKeys);
    cleanup.disconnect();

    section('1. AC — 크로스 replica 복구: A 에서 끊기고 B 로 재연결해도 놓친 이벤트가 도착하는가');
    {
        const a = await makeReplica('A', { maxDisconnectionDuration: 10_000 });
        const b = await makeReplica('B', { maxDisconnectionDuration: 10_000 });
        // Give the adapters' heartbeat a moment to discover each other —
        // mirrors socket.ts's own peers-visible gate before trusting the bus.
        await sleep(1500);

        const client = ioClient(a.url, { path: '/v1/updates', transports: ['websocket'], reconnection: false });
        await waitConnect(client);
        const clientSocketId = client.id;
        info(`A 에 연결: socketId=${clientSocketId}`);

        // Server joins this connection to a room and will emit into it while
        // the client is down — this is the "missed event" the recovery has
        // to replay.
        let servedSocket;
        for (const candidate of a.io.of('/').sockets.values()) {
            if (candidate.id === clientSocketId) servedSocket = candidate;
        }
        servedSocket.join('smoke-room');
        await primeOffset(a, 'smoke-room', client);

        const received = [];
        client.on('missed-event', (payload) => received.push(payload));

        killClientTransport(a, clientSocketId);
        await sleep(300); // let the abrupt close actually propagate server-side

        // Emitted while the client has no live connection anywhere.
        a.io.to('smoke-room').emit('missed-event', { seq: 1 });
        await sleep(300);

        const reconnected = reconnectAcrossReplica(client, b);
        reconnected.on('missed-event', (payload) => received.push(payload));
        await waitConnect(reconnected);

        if (reconnected.recovered !== true) {
            fail(`recovered=${reconnected.recovered} — 기대: true (B 가 A 의 세션을 Redis 에서 복구하지 못했다)`);
        } else {
            pass('B 가 recovered=true 로 보고했다 — A 의 세션을 Redis 를 통해 복구했다');
        }
        await sleep(500); // replayed events arrive as normal 'missed-event' emissions
        if (received.length === 1 && received[0]?.seq === 1) {
            pass('끊긴 동안 발생한 이벤트가 재연결 후 정확히 1건 도착했다');
        } else {
            fail(`받은 이벤트: ${JSON.stringify(received)} — 기대: [{seq:1}] 정확히 1건`);
        }

        client.disconnect(); reconnected.disconnect();
        await a.close(); await b.close();
    }

    section('2. 음성 대조 — 세션 만료 후에는 recovered=false 로 떨어지는가');
    {
        // maxDisconnectionDuration 이 매우 짧으면 persistSession 의 Redis TTL
        // (PX ms, socket.io 가 그대로 넘긴다) 이 만료돼 GETDEL 이 빈 손으로
        // 돌아온다 — restoreSession 이 reject 하고 recovered 는 false 가
        // 된다. D2(maxDisconnectionDuration 값)의 안전망이 실제로 작동하는지
        // 확인한다: 이 창을 놓치면 조용히 무한 복구를 시도하는 게 아니라
        // 명확히 false 로 떨어져 클라이언트가 기존 전체 복구 경로를 타야
        // 한다.
        const a = await makeReplica('A', { maxDisconnectionDuration: 300 });
        await sleep(300);

        const client = ioClient(a.url, { path: '/v1/updates', transports: ['websocket'], reconnection: false });
        await waitConnect(client);
        const clientSocketId = client.id;
        // Every socket auto-joins a room named after its own id.
        await primeOffset(a, clientSocketId, client);

        killClientTransport(a, clientSocketId);
        await sleep(800); // well past the 300ms session TTL

        const reconnected = ioClient(a.url, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true,
        });
        reconnected._pid = client._pid;
        reconnected._lastOffset = client._lastOffset;
        await waitConnect(reconnected);

        if (reconnected.recovered === false) {
            pass('세션 만료 후 recovered=false — 전체 복구 경로로 안전하게 떨어진다');
        } else {
            fail(`recovered=${reconnected.recovered} — 기대: false (세션이 만료됐는데도 복구된 것으로 보고됨)`);
        }

        client.disconnect(); reconnected.disconnect();
        await a.close();
    }

    section('3. 쓰기 부하 중 복구 — restoreSession 의 100회 XRANGE 상한이 실제로 이벤트를 누락시키는가');
    {
        // spec §2 의 FIXME: 어댑터의 재생 루프가 100라운드 안에 스트림 끝을
        // 못 따라잡아도 reject 하지 않고 그냥 return 한다 — recovered=true
        // 인데 missedPackets 가 잘렸을 수 있다는 뜻이다. 끊긴 동안 계속
        // 쓰기가 들어오는 상태를 실제로 만들어 확인한다.
        const a = await makeReplica('A', { maxDisconnectionDuration: 15_000 });
        const b = await makeReplica('B', { maxDisconnectionDuration: 15_000 });
        await sleep(1500);

        const client = ioClient(a.url, { path: '/v1/updates', transports: ['websocket'], reconnection: false });
        await waitConnect(client);
        const clientSocketId = client.id;
        let servedSocket;
        for (const candidate of a.io.of('/').sockets.values()) {
            if (candidate.id === clientSocketId) servedSocket = candidate;
        }
        servedSocket.join('smoke-room');
        await primeOffset(a, 'smoke-room', client);

        killClientTransport(a, clientSocketId);
        await sleep(200);

        const TOTAL_EVENTS = 5000;
        info(`끊긴 동안 ${TOTAL_EVENTS}건을 최대한 빠르게 쓴다 (다른 사용자 트래픽 시뮬레이션)`);
        for (let i = 0; i < TOTAL_EVENTS; i++) {
            a.io.to('smoke-room').emit('load-event', { seq: i });
        }
        // Give the stream a moment to actually persist everything server-side
        // before reconnecting — otherwise this measures write latency, not
        // the 100-round cap.
        await sleep(1000);

        const received = [];
        const reconnected = reconnectAcrossReplica(client, b);
        reconnected.on('load-event', (payload) => received.push(payload.seq));
        await waitConnect(reconnected);

        if (reconnected.recovered !== true) {
            fail(`recovered=${reconnected.recovered} — 부하 테스트 전제가 깨졌다(세션을 아예 못 찾음), 아래 개수 비교는 무의미하다`);
        }
        await sleep(1500);

        const missing = TOTAL_EVENTS - received.length;
        if (missing === 0) {
            pass(`${TOTAL_EVENTS}건 전부 도착 — 이 부하 수준에서는 100회 상한에 걸리지 않는다`);
        } else {
            fail(`${missing}/${TOTAL_EVENTS}건 누락 — recovered=true 인데 이벤트가 빠졌다. `
                + `D2(maxDisconnectionDuration) 재검토 대상: adapter.js restoreSession 의 `
                + `RESTORE_SESSION_MAX_XRANGE_CALLS=100 상한에 걸린 것으로 보인다.`);
        }

        client.disconnect(); reconnected.disconnect();
        await a.close(); await b.close();
    }

    printSummaryAndExit();
}

function printSummaryAndExit() {
    section('결과');
    console.log(`  실패 ${failed}건`);
    console.log(failed > 0
        ? '  → connectionStateRecovery 를 켤 준비가 안 됐다. Phase 4 로 넘어가지 말 것.'
        : '  → 크로스 replica 복구 확인. Phase 4(서버 활성화) 로 진행 가능.');
    console.log('');
    process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => {
    console.error(`\n실행 오류: ${e.stack ?? e.message}`);
    process.exitCode = 1;
});
