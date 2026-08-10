#!/usr/bin/env node
/**
 * Cross-placement smoke for relay-cross-replica-routing (spec AC1/AC2/AC3).
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE OLD SCRIPT
 * -------------------------------------------------
 * aplus-dev-studio `specs/happy-server-horizontal-scale/smoke-cross-replica.sh`
 * could never prove AC1. It drove traffic through the Service and read
 * `rpc_calls_total{result="success"}`, but `fetchSockets()` returns local
 * sockets too — so `success` rises identically whether the browser and the
 * daemon shared a replica or not. Its own context.md records this gap.
 *
 * The trick here: **address every replica directly, bypassing the Service, and
 * require all of them to succeed.** A daemon is attached to exactly one
 * replica, so if every replica can serve a request for that machine, the
 * others necessarily crossed. Before this spec's changes exactly one replica
 * would answer and the rest would 502 / "Machine not connected" — which is
 * precisely the 2026-08-07 failure. No need to know which replica owns the
 * daemon, and no way to pass by accident.
 *
 * JUDGEMENT PRINCIPLE (inherited): "could not check" is not PASS. Missing
 * credentials produce SKIP and a non-zero exit unless SMOKE_ALLOW_SKIP=1, so a
 * half-run cannot be mistaken for a green run.
 *
 * READ-ONLY. Opens a terminal and a preview request against the user's own
 * machine; deletes nothing, restarts nothing. The session-spawn RPC check
 * (§6) calls `spawn-happy-session` with an unencrypted empty `params` — the
 * legacy decrypt path throws before handler dispatch; the dataKey path returns
 * null and the handler's first parameter guard rejects it. Neither path reaches
 * `spawnSession()`; see §6 for why the round trip still proves routing.
 *
 * USAGE
 *   SMOKE_TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.happy/access.key'))['token'])") \
 *   node smoke-cross-placement.mjs [namespace]
 *
 *   SMOKE_MACHINE=<machineId>   pin the machine (default: first online machine)
 *   SMOKE_PORT=<port>           port to probe (default 59999 — see below)
 *   SMOKE_ALLOW_SKIP=1          exit 0 even when checks were skipped
 *   SMOKE_KEEP_PF=1             leave port-forwards running (debugging)
 *
 * TOKEN: the bearer the CLI and web app use. `~/.happy/access.key` is JSON
 * with a `token` field (persistence.ts readCredentials). Browser devtools —
 * the Authorization header on any /v1 request — works too.
 *
 * PORT: does NOT need anything listening. The relay answers 502 in two
 * distinguishable ways, and only one of them means routing failed:
 *   { error: "Machine offline" }              → never reached the daemon  ✗
 *   { code: "CONNECTION_REFUSED", ... }       → daemon answered; port shut ✓
 * A refused connection still proves the request crossed to the daemon and
 * came back, which is exactly what AC1 asks. So the default probes a port
 * that is almost certainly closed and treats a daemon-sourced error as a
 * pass. Pass SMOKE_PORT only if you want a real 200 through a live server.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { createRequire } from 'node:module';

// pnpm keeps node_modules strict and `specs/` is not a workspace package, so
// resolve the client from a package that actually depends on it.
function loadSocketIoClient() {
    const bases = [
        '../../packages/happy-cli/package.json',
        '../../packages/happy-server/package.json',
        '../../package.json',
    ];
    for (const base of bases) {
        try {
            return createRequire(new URL(base, import.meta.url))('socket.io-client').io;
        } catch { /* try the next base */ }
    }
    throw new Error(
        'socket.io-client 를 찾을 수 없다. vendor/happy 에서 `pnpm install` 을 먼저 실행하라.',
    );
}
const ioClient = loadSocketIoClient();

const NS = process.argv[2] ?? 'aplus-dev-studio-dev-shared';
const TOKEN = process.env.SMOKE_TOKEN ?? '';
// Closed on purpose by default — a daemon-sourced CONNECTION_REFUSED proves
// the round trip just as well as a 200, without needing a live dev server.
const PORT = Number(process.env.SMOKE_PORT ?? 59999);
const PIN_MACHINE = process.env.SMOKE_MACHINE ?? '';
const ALLOW_SKIP = process.env.SMOKE_ALLOW_SKIP === '1';
const KEEP_PF = process.env.SMOKE_KEEP_PF === '1';
const APP_PORT = 3000;
const METRICS_PORT = 9090;

let failed = 0;
let skipped = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.log(`  FAIL  ${m}`); failed++; };
const skip = (m) => { console.log(`  SKIP  ${m}`); skipped++; };
const info = (m) => console.log(`        ${m}`);
const section = (m) => console.log(`\n== ${m}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd, args) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { err += d; });
        p.on('close', (code) => code === 0
            ? resolve(out)
            : reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${err.trim()}`)));
    });
}

async function freePort() {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const { port } = srv.address();
    await new Promise((r) => srv.close(r));
    return port;
}

const forwards = [];
/** Port-forward straight to one pod so the Service/ingress cannot pick for us. */
async function portForward(pod, remotePort) {
    const local = await freePort();
    const p = spawn('kubectl', ['-n', NS, 'port-forward', pod, `${local}:${remotePort}`],
        { stdio: ['ignore', 'ignore', 'pipe'] });
    forwards.push(p);
    // Wait for the tunnel to accept connections rather than sleeping blindly.
    for (let i = 0; i < 50; i++) {
        await sleep(200);
        try {
            const s = net.createConnection({ host: '127.0.0.1', port: local });
            await once(s, 'connect');
            s.destroy();
            return local;
        } catch { /* not up yet */ }
    }
    throw new Error(`port-forward to ${pod}:${remotePort} never became ready`);
}

function cleanupForwards() {
    if (KEEP_PF) return;
    for (const p of forwards) { try { p.kill(); } catch { /* gone */ } }
}

async function api(base, path, { method = 'GET', body, token = TOKEN } = {}) {
    const res = await fetch(`http://127.0.0.1:${base}${path}`, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    return res;
}

/**
 * Sends a raw WebSocket upgrade to the preview relay and returns the status
 * line. Raw `net` rather than a ws client on purpose: the upstream port is
 * closed, so no handshake will ever complete — what we want is the relay's own
 * HTTP error, and those two errors are exactly what tells routing apart:
 *   "502 Machine Offline" → never reached the daemon  (previewWebSocketRelay:291)
 *   "502 Bad Gateway"     → daemon answered, port shut (previewWebSocketRelay:325)
 */
function probeWsUpgrade(localPort, machineId, port, ptoken) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: localPort });
        let buf = '';
        const done = (statusLine) => {
            socket.destroy();
            resolve(statusLine);
        };
        const timer = setTimeout(() => done('TIMEOUT'), 20_000);
        socket.on('connect', () => {
            const key = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 37) % 256)).toString('base64');
            socket.write(
                `GET /v1/preview/${machineId}/${port}/?ptoken=${encodeURIComponent(ptoken)} HTTP/1.1\r\n` +
                `Host: 127.0.0.1:${localPort}\r\n` +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                `Sec-WebSocket-Key: ${key}\r\n` +
                'Sec-WebSocket-Version: 13\r\n\r\n',
            );
        });
        socket.on('data', (chunk) => {
            buf += chunk.toString('latin1');
            if (buf.includes('\r\n')) {
                clearTimeout(timer);
                done(buf.split('\r\n')[0]);
            }
        });
        socket.on('error', (e) => { clearTimeout(timer); done(`ERROR ${e.code ?? e.message}`); });
        socket.on('close', () => { clearTimeout(timer); done(buf.split('\r\n')[0] || 'CLOSED'); });
    });
}

async function main() {
    console.log(`happy-server 크로스 배치 스모크 — namespace=${NS}`);

    section('0. 전제');
    const podsRaw = await sh('kubectl', ['-n', NS, 'get', 'pods',
        '-l', 'app.kubernetes.io/name=happy-server',
        '--field-selector=status.phase=Running', '-o', 'name']);
    const pods = podsRaw.split('\n').map((s) => s.trim().replace(/^pod\//, '')).filter(Boolean);
    info(`replica: ${pods.length}개 — ${pods.join(', ')}`);
    if (pods.length < 2) {
        fail(`replicas >= 2 가 필요하다 (현재 ${pods.length}). 크로스 배치를 만들 수 없다.`);
        return;
    }
    pass(`replicas=${pods.length}`);

    section('1. 클러스터 버스 — 각 replica 가 peer 를 보는가');
    // socketio_cluster_peers 는 이 spec 에서 추가한 지표다. 0 이면 fetchSockets 가
    // 에러 없이 로컬 결과만 반환하는 상태이고, 그러면 아래 검사들은 전부
    // "우연히 같은 replica" 여부만 보게 된다.
    let busOk = true;
    for (const pod of pods) {
        const mp = await portForward(pod, METRICS_PORT);
        const text = await (await fetch(`http://127.0.0.1:${mp}/metrics`)).text();
        const m = text.match(/^socketio_cluster_peers.*?\s([-\d.]+)$/m);
        if (!m) {
            fail(`${pod}: socketio_cluster_peers 부재 — 이 spec 의 계측이 배포되지 않았다`);
            busOk = false;
            continue;
        }
        const peers = Number(m[1]);
        if (peers === pods.length - 1) pass(`${pod}: peers=${peers}`);
        else { fail(`${pod}: peers=${peers} (기대 ${pods.length - 1}) — 버스가 끊겼다`); busOk = false; }
    }
    if (!busOk) {
        info('버스가 성립하지 않으면 아래 결과는 의미가 없다. 여기서 멈춘다.');
        return;
    }

    if (!TOKEN) {
        section('2~4. 기능 검사');
        skip('SMOKE_TOKEN 이 없다 — 프리뷰/터미널 왕복을 확인할 수 없다');
        return;
    }

    // 첫 replica 를 "제어용" 으로 써서 머신 목록과 ptoken 을 얻는다.
    const ctrl = await portForward(pods[0], APP_PORT);

    section('2. 대상 머신 선정');
    const machinesRes = await api(ctrl, '/v1/machines');
    if (!machinesRes.ok) {
        fail(`GET /v1/machines → ${machinesRes.status} (토큰이 유효한가?)`);
        return;
    }
    // GET /v1/machines answers with a bare array, not { machines: [...] }.
    const raw = await machinesRes.json();
    const machines = Array.isArray(raw) ? raw : (raw?.machines ?? []);
    const online = machines.filter((m) => m.active === true);
    info(`머신 ${machines.length}개 중 온라인 ${online.length}개`);
    const machineId = PIN_MACHINE || online[0]?.id;
    if (!machineId) {
        // `active:false` means no daemon socket. Authenticating creates the
        // machine row; the daemon still has to be running (`happy daemon start`).
        fail(`온라인 머신이 없다 — 인증만으로는 부족하고 데몬이 실행 중이어야 한다`
            + (machines.length ? ` (등록된 머신: ${machines.map((m) => `${m.id}:active=${m.active}`).join(', ')})` : ''));
        return;
    }
    if (PIN_MACHINE && !online.some((m) => m.id === PIN_MACHINE)) {
        // Otherwise every downstream failure looks like a routing bug.
        fail(`SMOKE_MACHINE=${PIN_MACHINE} 은 온라인 목록에 없다 — 서버가 아는 머신: ${machines.map((m) => m.id).join(', ') || '없음'}`);
        return;
    }
    info(`machineId=${machineId}`);

    // 데몬 소켓이 정확히 1개여야 "다른 replica 는 반드시 건너뛴 것" 이 성립한다.
    let daemonSockets = 0;
    for (const pod of pods) {
        const mp = await portForward(pod, METRICS_PORT);
        const text = await (await fetch(`http://127.0.0.1:${mp}/metrics`)).text();
        for (const line of text.split('\n')) {
            if (line.startsWith('websocket_connections_total') && line.includes('type="machine-scoped"')) {
                daemonSockets += Number(line.trim().split(/\s+/).pop()) || 0;
            }
        }
    }
    info(`machine-scoped 소켓 총합: ${daemonSockets} (전체 머신 기준)`);
    pass(`대상 머신 확보`);

    section(`3. AC1 — 프리뷰 HTTP 가 모든 replica 에서 데몬까지 도달하는가 (port=${PORT})`);
    {
        const mint = await api(ctrl, '/v1/preview-token', {
            method: 'POST', body: { machineId, port: PORT },
        });
        if (!mint.ok) {
            fail(`POST /v1/preview-token → ${mint.status}`);
        } else {
            const { token: ptoken } = await mint.json();
            const results = [];
            for (const pod of pods) {
                const ap = await portForward(pod, APP_PORT);
                const res = await fetch(
                    `http://127.0.0.1:${ap}/v1/preview/${machineId}/${PORT}/?ptoken=${encodeURIComponent(ptoken)}`,
                    { redirect: 'manual' },
                );
                let body = {};
                try { body = await res.json(); } catch { /* html/binary body = a real 200 */ }
                // The whole point: a 502 carrying a daemon `code` means the
                // request reached the daemon and came back. Only a 502 without
                // one ("Machine offline" / lookup-degraded) is a routing miss.
                //
                // Anything else (401/403/404 from a bad ptoken or machine id) is
                // a broken fixture, NOT evidence about routing — counting it as
                // "reached" would make the smoke pass for the wrong reason.
                const daemonAnswered = res.status === 502 && typeof body?.code === 'string';
                const served = res.status < 400;
                const verdict = daemonAnswered ? 'daemon-reached'
                    : served ? 'served'
                        : res.status === 502 ? 'routing-miss'
                            : 'setup-error';
                results.push({ pod, status: res.status, code: body?.code, verdict });
                info(`${pod} → ${res.status}${body?.code ? ` code=${body.code}` : ''} (${verdict})`);
            }
            const setupErrors = results.filter((r) => r.verdict === 'setup-error');
            const missed = results.filter((r) => r.verdict === 'routing-miss');
            if (setupErrors.length > 0) {
                // Not a routing verdict either way — say so instead of guessing.
                fail(`픽스처 오류: ${setupErrors.map((r) => `${r.pod}=${r.status}`).join(', ')} — ptoken/머신 불일치로 보인다. 라우팅에 대해서는 아무것도 증명하지 못했다.`);
            } else if (missed.length === 0) {
                pass(`모든 replica 가 데몬에 도달했다 — 최소 ${pods.length - 1}개는 replica 를 건넜다`);
            } else if (missed.length === results.length) {
                fail('모든 replica 가 데몬에 도달하지 못했다 — 머신이 오프라인일 수 있다 (라우팅 문제와 구별 불가)');
            } else {
                fail(`${missed.length}/${results.length} replica 가 도달 실패 — 조회가 여전히 프로세스 로컬이다: ${missed.map((r) => r.pod).join(', ')}`);
            }
        }
    }

    section('4. AC3 — 터미널이 모든 replica 에서 열리는가');
    for (const pod of pods) {
        const ap = await portForward(pod, APP_PORT);
        const socket = ioClient(`http://127.0.0.1:${ap}`, {
            path: '/v1/updates',
            transports: ['websocket'],
            auth: { token: TOKEN, clientType: 'user-scoped' },
            reconnection: false,
            timeout: 10_000,
        });
        try {
            await new Promise((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('connect_error', reject);
                setTimeout(() => reject(new Error('connect timeout')), 12_000);
            });
            const ack = await new Promise((resolve) => {
                socket.timeout(15_000).emit('terminal-open', { machineId, params: null },
                    (err, resp) => resolve(err ? { ok: false, error: String(err.message ?? err) } : resp));
            });
            if (ack?.ok === true) {
                pass(`${pod}: terminal-open 성공 (session=${String(ack.sessionId).slice(0, 8)}…)`);
                socket.emit('terminal-close', { sessionId: ack.sessionId });
            } else {
                fail(`${pod}: terminal-open 실패 — ${ack?.error ?? '알 수 없음'}`);
            }
        } catch (e) {
            fail(`${pod}: 소켓 연결 실패 — ${e.message}`);
        } finally {
            socket.close();
        }
    }
    info('데몬은 한 replica 에만 붙어 있으므로, 두 replica 모두 성공했다면 한쪽은 건넌 것이다.');

    section(`5. AC2 — 프리뷰 WS 업그레이드가 모든 replica 에서 데몬까지 도달하는가 (port=${PORT})`);
    {
        const mint = await api(ctrl, '/v1/preview-token', {
            method: 'POST', body: { machineId, port: PORT },
        });
        if (!mint.ok) {
            fail(`POST /v1/preview-token → ${mint.status}`);
        } else {
            const { token: ptoken } = await mint.json();
            const results = [];
            for (const pod of pods) {
                const ap = await portForward(pod, APP_PORT);
                const status = await probeWsUpgrade(ap, machineId, PORT, ptoken);
                // 101 would mean the upstream actually accepted (live port).
                const served = status.includes(' 101 ');
                const daemonAnswered = status.includes('502 Bad Gateway');
                const routingMiss = status.includes('502 Machine Offline');
                const verdict = served ? 'served'
                    : daemonAnswered ? 'daemon-reached'
                        : routingMiss ? 'routing-miss'
                            : 'setup-error';
                results.push({ pod, status, verdict });
                info(`${pod} → ${status} (${verdict})`);
            }
            const setupErrors = results.filter((r) => r.verdict === 'setup-error');
            const missed = results.filter((r) => r.verdict === 'routing-miss');
            if (setupErrors.length > 0) {
                fail(`픽스처 오류: ${setupErrors.map((r) => `${r.pod}="${r.status}"`).join(', ')} — 라우팅에 대해서는 아무것도 증명하지 못했다.`);
            } else if (missed.length === 0) {
                pass(`모든 replica 의 WS 업그레이드가 데몬에 도달했다 — 최소 ${pods.length - 1}개는 replica 를 건넜다`);
            } else if (missed.length === results.length) {
                fail('모든 replica 가 Machine Offline — 머신이 오프라인일 수 있다 (라우팅 문제와 구별 불가)');
            } else {
                fail(`${missed.length}/${results.length} replica 가 Machine Offline — WS 조회가 여전히 프로세스 로컬이다: ${missed.map((r) => r.pod).join(', ')}`);
            }
        }
    }

    section('6. AC1 — 세션 spawn RPC 가 모든 replica 에서 데몬까지 도달하는가');
    // aplus-dev-studio specs/happy-server-horizontal-scale Phase 2 기록:
    // "V2 는 임의 daemon RPC 를 관측했을 뿐 세션 spawn 을 특정하지 않았다."
    // rpc-call 전송 자체는 'bash' 등 다른 method 로 이미 실측됐지만(rpcHandler.ts
    // 가 method 이름과 무관하게 같은 room+fetchSockets 경로를 타므로 구조적으로는
    // 같다), spawn-happy-session 을 직접 겨냥한 적은 없었다. 여기서 닫는다.
    //
    // web-ui 의 실제 호출(index.ts:5925)은 params 를 machine 의 secretKey 로
    // 암호화해 보낸다. 이 스모크는 그 키가 없으므로 **일부러 빈 문자열**을
    // 보낸다 — daemon 쪽 RpcHandlerManager.handleRequest() 는
    // `decrypt(key, variant, decodeBase64(request.params))` 를 메서드 핸들러
    // 호출 전에 실행하고, 전체를 try/catch 로 감싼다
    // (packages/happy-cli/src/api/rpc/RpcHandlerManager.ts). legacy variant 는
    // 빈 bundle 복호화가 throw 하므로 핸들러 전에 catch 된다. dataKey variant 는
    // throw 대신 null 을 반환해 핸들러에 진입하지만, spawn-happy-session 핸들러의
    // 첫 parameter guard 가 로깅·destructuring·spawnSession() 전에 거부한다
    // (packages/happy-cli/src/api/apiMachine.ts). 두 경로 모두 catch 가 암호화된
    // 에러 블롭을 정상 반환하며 세션은 만들어지지 않는다. 요청이 daemon 까지
    // 갔다 왔다는 것 자체가 왕복 증거이고, 페이로드 내용(우리는 복호화 못 함)은
    // 무관하다 — 프리뷰 릴레이의 "닫힌 포트에 CONNECTION_REFUSED" 와 같은 원리.
    //
    // 판정 기준은 브라우저가 보는 rpc-call 응답의 최상위 `ok` 뿐이다
    // (rpcHandler.ts): `ok:true` 는 daemon 이 요청을 받고 **뭔가** 응답했다는
    // 뜻(내용이 암호화된 에러여도 무방), `ok:false` + "not available" 은 room 이
    // 비어 있었다는 뜻(라우팅 실패) — 나머지는 방화벽 픽스처 오류.
    for (const pod of pods) {
        const ap = await portForward(pod, APP_PORT);
        const socket = ioClient(`http://127.0.0.1:${ap}`, {
            path: '/v1/updates',
            transports: ['websocket'],
            auth: { token: TOKEN, clientType: 'user-scoped' },
            reconnection: false,
            timeout: 10_000,
        });
        try {
            await new Promise((resolve, reject) => {
                socket.once('connect', resolve);
                socket.once('connect_error', reject);
                setTimeout(() => reject(new Error('connect timeout')), 12_000);
            });
            const ack = await new Promise((resolve) => {
                socket.timeout(15_000).emit('rpc-call', { method: `${machineId}:spawn-happy-session`, params: '' },
                    (err, resp) => resolve(err ? { ok: false, error: String(err.message ?? err) } : resp));
            });
            const routingMiss = ack?.ok === false && /not available/i.test(String(ack?.error ?? ''));
            if (ack?.ok === true) {
                pass(`${pod}: daemon 도달 (응답 수신 — 암호화된 에러 블롭이라 내용은 검사하지 않는다)`);
            } else if (routingMiss) {
                fail(`${pod}: RPC method not available — 라우팅 실패로 보인다(데몬이 이 replica 에서 안 보인다)`);
            } else {
                fail(`${pod}: 예상 밖 응답 — ${JSON.stringify(ack)}`);
            }
        } catch (e) {
            fail(`${pod}: 소켓 연결 실패 — ${e.message}`);
        } finally {
            socket.close();
        }
    }
    info('데몬은 한 replica 에만 붙어 있으므로, 두 replica 모두 daemon 도달이면 한쪽은 건넌 것이다.');
}

main()
    .catch((e) => { console.error(`\n실행 오류: ${e.message}`); failed++; })
    .finally(async () => {
        cleanupForwards();
        section('결과');
        console.log(`  실패 ${failed}건, 건너뜀 ${skipped}건`);
        if (failed > 0) {
            console.log('  → 크로스 배치가 성립하지 않는다. replicas=2 로 올리지 말 것.');
        } else if (skipped > 0 && !ALLOW_SKIP) {
            console.log('  → 통과했지만 확인하지 못한 항목이 있다. 이건 PASS 가 아니다.');
        } else {
            console.log('  → AC1/AC2/AC3 크로스 배치 확인.');
        }
        console.log('');
        process.exit(failed > 0 || (skipped > 0 && !ALLOW_SKIP) ? 1 : 0);
    });
