/**
 * specs/managed-cloud-byos §5.36 — daemon 측 launcher client.
 *
 * `managedRpcHandlers` 의 `fencingBackend` 를 채운다. daemon 은 **권한 주체가
 * 아니다** — 세대를 지목해 물어볼 뿐이고, 죽이는 것도 증명하는 것도 supervisor 다.
 *
 * 두 가지를 절대 하지 않는다:
 *  - 응답을 받지 못했다고 해서 정지했다고 말하지 않는다. `requested:false` 를
 *    지우면 lease 가 유지되는 한 자식이 영원히 남는다(§5.6).
 *  - 증명이 없다고 해서 "돌지 않았다" 로 읽지 않는다. 근거 부재는 `unknown` 이다.
 */
import { connect, type Socket } from 'node:net';
import { dirname } from 'node:path';

import {
    defaultProvisioningDeps,
    trustedPathRefusal,
    type ManagedProvisioningDeps,
} from '@/daemon/managedRuntimeIdentity';
import { MANAGED_GRANT_PARAMS_MAX_BYTES, parseSupervisorHello, type SupervisorHello } from '@/launcher/ipcServer';

/**
 * 소켓 경로가 신뢰되지 않아 **연결조차 하지 않았다**는 사실.
 *
 * 메시지는 고정 문자열 하나다. walker 가 만드는 `"<component>: <reason>"` 진단은
 * 여기서 버린다 — 그 안에 경로가 들어 있고, 이 값은 로그와 RPC 응답으로 흘러간다.
 * `ask()` 가 이 타입 **하나만** 구분하며 `message`/`code` 는 읽지 않는다: 임의
 * 문자열이 거절 코드가 되면 backend 가 자기 코드를 고르게 된다.
 *
 * **export 하지 않는다.** 밖에서 만들 수 있으면 그 코드를 만든 주체가 이 모듈이라는
 * 사실이 사라지고, 테스트도 실제 판정 대신 자기가 던진 값을 확인하게 된다.
 */
class LauncherPathUntrustedError extends Error {
    constructor() {
        super('backend-path-untrusted');
        this.name = 'LauncherPathUntrustedError';
    }
}

// lease deadline 은 프로세스 경계를 넘어 비교된다. daemon 과 supervisor 가
// **같은 함수**를 써야 두 값의 원점이 같다. 여기서 다시 구현하지 않는다.
export { systemMonotonicNow } from '@/launcher/supervisor';

export type LauncherClientDeps = {
    /** 한 요청을 보내고 한 줄 응답을 받는다. */
    request: (payload: string, options?: { mode: 'hello' }) => Promise<string>;
};

const HELLO_MAX_FRAME_BYTES = 4096;
const HELLO_DEADLINE_MS = 5_000;

type HelloTransportReason = 'timeout' | 'response-too-large' | 'malformed-response';
class HelloTransportError extends Error {
    constructor(readonly reason: HelloTransportReason) { super(reason); }
}

export type LauncherHelloResult = { ok: true; result: SupervisorHello }
    | { ok: false; reason: HelloTransportReason | 'transport' | 'backend-path-untrusted' | 'hello-refused' };

export type BackendStopResult = { requested: boolean; detail: string };

function parseResponse(raw: string): { ok: true; result: unknown } | { ok: false; reason: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { ok: false, reason: 'malformed-response' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'malformed-response' };
    }
    const record = parsed as Record<string, unknown>;
    if (record.ok === true) return { ok: true, result: record.result };
    const reason = typeof record.reason === 'string' ? record.reason : 'refused';
    return { ok: false, reason };
}

export function createLauncherClient(input: { token: string; deps: LauncherClientDeps }) {
    async function ask(payload: Record<string, unknown>): Promise<
        { ok: true; result: unknown } | { ok: false; reason: string }
    > {
        let raw: string;
        try {
            raw = await input.deps.request(`${JSON.stringify({ ...payload, token: input.token })}\n`);
        } catch (error) {
            /*
             * 경로 게이트만 자기 코드를 갖는다. 그 판정은 **이 프로세스가** 내렸고
             * token 은 나가지 않았다. 나머지는 지금까지와 같이 전부 `transport` 다.
             *
             * `instanceof` 이므로 센티널은 같은 모듈 인스턴스에서 와야 한다. 모듈이
             * 두 번 적재되면 `transport` 로 떨어진다 — fail-closed 이지만 코드가
             * 사라지므로, 이 타입을 mock 으로 갈아끼우지 않는다.
             */
            if (error instanceof LauncherPathUntrustedError) {
                return { ok: false, reason: 'backend-path-untrusted' };
            }
            // 원문은 옮기지 않는다.
            return { ok: false, reason: 'transport' };
        }
        return parseResponse(raw);
    }

    return {
        async hello(): Promise<LauncherHelloResult> {
            let raw: string;
            try {
                raw = await input.deps.request(JSON.stringify({ op: 'hello', token: input.token }) + '\n', { mode: 'hello' });
            } catch (error) {
                if (error instanceof LauncherPathUntrustedError) return { ok: false, reason: 'backend-path-untrusted' };
                if (error instanceof HelloTransportError) return { ok: false, reason: error.reason };
                return { ok: false, reason: 'transport' };
            }
            // Injected transports return a raw line; enforce the same payload cap here.
            const newline = raw.indexOf('\n');
            const frame = newline < 0 ? raw : raw.slice(0, newline);
            if (Buffer.byteLength(frame, 'utf8') > HELLO_MAX_FRAME_BYTES) return { ok: false, reason: 'response-too-large' };
            let parsed: unknown;
            try { parsed = JSON.parse(frame); } catch { return { ok: false, reason: 'malformed-response' }; }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'malformed-response' };
            const record = parsed as Record<string, unknown>;
            if (Object.keys(record).length !== 2) return { ok: false, reason: 'malformed-response' };
            if (record.ok === false && typeof record.reason === 'string') return { ok: false, reason: 'hello-refused' };
            if (record.ok !== true) return { ok: false, reason: 'malformed-response' };
            const result = parseSupervisorHello(record.result);
            return result ? { ok: true, result } : { ok: false, reason: 'malformed-response' };
        },
        /**
         * `managedRpcHandlers` 의 계약 그대로 **`belowEpoch` 하나만** 받는다.
         * run/attempt 로 좁히지 않는다 — teardown 은 `MAX_SAFE_INTEGER` 로 불러
         * 이 runtime 이 띄운 **모든** 세대를 묻는다.
         *
         * supervisor 가 답하지 못하면 증명되지 않은 것이다.
         */
        async proveGenerationStopped(request: { belowEpoch: number }): Promise<{ proven: boolean; detail: string }> {
            const answer = await ask({ op: 'prove-below', belowEpoch: request.belowEpoch });
            if (!answer.ok) return { proven: false, detail: answer.reason };
            const result = answer.result;
            if (!result || typeof result !== 'object') return { proven: false, detail: 'malformed-response' };
            const record = result as Record<string, unknown>;
            // `proven` 이 명시적으로 true 일 때만 증명이다.
            if (record.proven !== true) {
                return {
                    proven: false,
                    detail: typeof record.detail === 'string' ? record.detail : 'not-proven',
                };
            }
            return { proven: true, detail: typeof record.detail === 'string' ? record.detail : 'proven' };
        },

        /**
         * 1단계. bootstrap 은 바이트로 보낸다 — FD 도 경로도 넘기지 않는다.
         * 돌려받는 PID 는 helper 가 스스로 보고한 값이고, handle 은 일회용이다.
         */
        async prepareLaunch(request: {
            key: { runId: string; attemptId: string; epoch: number };
            leaseExpiresMonotonic: number;
            bootstrap: Buffer;
            /** 자식이 보고를 서명할 자격. 봉투와 별개의 문서다. */
            reportCredential: Buffer;
        }): Promise<{ prepared: true; pid: number | null; handle: string }
            | { prepared: false; detail: string }> {
            const answer = await ask({
                op: 'prepare-launch',
                key: request.key,
                leaseExpiresMonotonic: request.leaseExpiresMonotonic,
                bootstrapBase64: request.bootstrap.toString('base64'),
                reportCredentialBase64: request.reportCredential.toString('base64'),
            });
            if (!answer.ok) return { prepared: false, detail: answer.reason };
            const result = answer.result as Record<string, unknown> | null;
            if (!result || typeof result !== 'object') {
                return { prepared: false, detail: 'malformed-response' };
            }
            if (result.prepared !== true || typeof result.handle !== 'string') {
                return {
                    prepared: false,
                    detail: typeof result.detail === 'string' ? result.detail : 'not-prepared',
                };
            }
            const pid = result.pid;
            return {
                prepared: true,
                pid: typeof pid === 'number' && Number.isSafeInteger(pid) ? pid : null,
                handle: result.handle,
            };
        },

        /**
         * 부모가 발급한 checkpoint target 을 supervisor 에 건넨다.
         *
         * **경계를 넘는 이유**: `managed:checkpoint` RPC 는 daemon 이 받고,
         * 그것을 놓아 둘 inbox 는 supervisor 프로세스에 있다 — 체크포인트
         * session 이 tool session 과 **같은 drain 객체**를 공유해야 하기
         * 때문이다. 두 프로세스는 메모리를 공유하지 않으므로 이 hop 이 있다.
         *
         * **바이트로 보낸다.** 경로로 보내면 무엇을 읽힐지 caller 가 고르게
         * 되고, 이 문서 안에는 한 체크포인트짜리 키와 서명된 업로드 URL 이
         * 있다. bootstrap 봉투가 같은 이유로 같은 모양이다.
         *
         * 수락되지 않은 것은 전부 **수락되지 않은 것**이다: 전송 실패도,
         * 거절도, 읽을 수 없는 답도. 하나라도 수락으로 접으면 부모는 자격이
         * 도착했다고 믿고, 그 자격은 아무도 모르는 채 만료된다.
         */
        async pushCheckpointTarget(target: unknown, dispatchToken: string): Promise<{
            accepted: boolean;
            /**
             * What the inbox did with it, when it accepted.
             *
             * All of its acceptances end this hop, and they differ in whether
             * an archive follows: `queued`/`replaced-unconsumed` mean one will,
             * `in-flight` means that id is already running, `already-completed`
             * means it published its pointer and is final. Carried rather than
             * flattened — the parent's next move differs for each.
             */
            state?: string;
            detail: string;
        }> {
            const answer = await ask({
                op: 'checkpoint-target',
                targetBase64: Buffer.from(JSON.stringify(target), 'utf8').toString('base64'),
                /*
                 * 부모의 서명을 **그대로** 나른다. daemon 은 이미 자기 몫으로
                 * 검증하지만 그 판정은 여기서 끝난다 — supervisor 는 marker 와
                 * 검증키를 쥐고 있으면서 대조할 것이 없어진다. 다시 만들면
                 * daemon 이 자기 권한의 발급자가 된다.
                 *
                 * bearer 와 같은 frame 에 있지만 서로 비교되지 않는다. 서명한
                 * 문서 **안에** 넣지 않는 것도 같은 이유다.
                 */
                dispatchToken,
            });
            if (!answer.ok) return { accepted: false, detail: answer.reason };
            const result = answer.result as Record<string, unknown> | null;
            if (!result || typeof result !== 'object') {
                return { accepted: false, detail: 'malformed-response' };
            }
            // `accepted` 가 명시적으로 true 일 때만 수락이다.
            if (result.accepted !== true) {
                return {
                    accepted: false,
                    detail: typeof result.detail === 'string' ? result.detail : 'not-accepted',
                };
            }
            const state = typeof result.state === 'string' && result.state.trim() !== ''
                ? result.state
                : null;
            /*
             * 수락인데 상태를 말하지 않으면 무엇이 일어나는지 모른다 — 그 답을
             * 배달로 읽으면 아카이브가 없는데 있다고 보고하게 된다.
             */
            if (state === null) return { accepted: false, detail: 'malformed-response' };
            /*
             * 수신단이 계약값으로 normalize 하면서 무엇이었는지를 `detail` 에
             * 담는다(예: `queued` + `replaced-unconsumed`). state 로 덮으면 그
             * 진단이 이 hop 에서 사라진다. 없을 때만 state 를 되풀이한다.
             */
            const detail = typeof result.detail === 'string' && result.detail.trim() !== ''
                ? result.detail
                : state;
            return { accepted: true, state, detail };
        },

        /** 2단계. 등록을 마친 뒤에만 부른다. */
        async releaseLaunch(handle: string): Promise<{ released: boolean; detail: string }> {
            const answer = await ask({ op: 'release-launch', handle });
            if (!answer.ok) return { released: false, detail: answer.reason };
            const result = answer.result as Record<string, unknown> | null;
            if (!result || typeof result !== 'object') {
                return { released: false, detail: 'malformed-response' };
            }
            return {
                released: result.released === true,
                detail: typeof result.detail === 'string' ? result.detail : 'unknown',
            };
        },

        /**
         * 부모의 runtime-lease 진술을 supervisor 에 그대로 넘긴다.
         *
         * `renew` 와 별개다: 그것은 세대별 deadline 을 옮기고, 이것은 서명된
         * 진술을 나른다. 여기서 다시 직렬화하지 않는다 — 서명이 덮는 것은
         * 부모가 보낸 그 문서다.
         */
        async pushRuntimeGrant(request: { token: string; params: unknown }): Promise<{
            admitted: boolean;
            detail: string;
        }> {
            const serialized = Buffer.from(JSON.stringify(request.params), 'utf8');
            /*
             * supervisor 가 어차피 거절할 크기라면 왕복을 쓰지 않고 여기서
             * 이름을 붙여 돌려준다. 경계는 여전히 supervisor 쪽이다 — 이것은
             * 진단이지 강제가 아니다.
             */
            if (serialized.length > MANAGED_GRANT_PARAMS_MAX_BYTES) {
                return { admitted: false, detail: 'grant-too-large' };
            }
            const answer = await ask({
                op: 'grant',
                paramsBase64: serialized.toString('base64'),
                dispatchToken: request.token,
            });
            if (!answer.ok) return { admitted: false, detail: answer.reason };
            const result = answer.result as Record<string, unknown> | null;
            if (!result || typeof result !== 'object') {
                return { admitted: false, detail: 'malformed-response' };
            }
            // 명시적 true 일 때만 관측으로 친다.
            if (result.admitted !== true) {
                return {
                    admitted: false,
                    detail: typeof result.detail === 'string' ? result.detail : 'not-admitted',
                };
            }
            return {
                admitted: true,
                detail: typeof result.detail === 'string' && result.detail.trim() !== ''
                    ? result.detail
                    : 'admitted',
            };
        },

        async renew(request: {
            key: { runId: string; attemptId: string; epoch: number };
            renewalSeq: number;
            leaseExpiresMonotonic: number;
        }): Promise<{ renewed: boolean; detail: string }> {
            const answer = await ask({ op: 'renew', ...request });
            if (!answer.ok) return { renewed: false, detail: answer.reason };
            const result = answer.result as Record<string, unknown> | null;
            if (!result || typeof result !== 'object') {
                return { renewed: false, detail: 'malformed-response' };
            }
            return {
                renewed: result.renewed === true,
                detail: typeof result.detail === 'string' ? result.detail : 'unknown',
            };
        },

        /** 정지 요청. 수락 여부를 **그대로** 돌려준다. */
        async requestStop(request: {
            runId: string; attemptId: string; epoch: number;
        }): Promise<BackendStopResult> {
            const answer = await ask({ op: 'request-stop', key: request });
            if (!answer.ok) return { requested: false, detail: answer.reason };
            const result = answer.result;
            if (!result || typeof result !== 'object') return { requested: false, detail: 'malformed-response' };
            const record = result as Record<string, unknown>;
            return {
                requested: record.requested === true,
                detail: typeof record.detail === 'string' ? record.detail : 'unknown',
            };
        },
    };
}

/** 운영 transport. 소켓 경로는 설정에서만 온다. */
/**
 * 요청 하나마다 **새 연결**이고, 그 첫 줄에 boot token 이 실린다. 그래서 경로 신뢰는
 * 연결마다 필요하다 — startup 에 한 번 확인한 것은 다음 연결을 대신하지 못한다.
 * 소켓이 그 사이 교체되면 이후 모든 요청이 token 을 그쪽에 넘긴다.
 *
 * 판정은 기존 walker 그대로이고, 소유자 정책만 호출자가 고른다: `daemonUid` 자리에
 * `0` 을 넘기면 `componentRefusal` 의 `uid !== 0 && uid !== daemonUid` 가
 * `uid !== 0` 으로 접혀 **root 전용**이 된다. 이것은 호출자의 정책 선택이지 caller
 * identity 를 위장하는 것이 아니며, 헬퍼의 일반 계약(root 또는 daemon)은 그대로 둔다.
 *
 * **소켓 leaf 는 보지 않는다.** 체인은 소켓의 디렉터리에서 멈춘다 — 디렉터리가 leaf 를
 * 지키고, 그 이름에 놓인 root 소유의 다른 파일은 `connect` 가 실패시켜 `transport` 가
 * 된다. 마지막 `lstat` 과 `connect` 사이의 창을 쓰려면 방금 root 소유·비-writable 로
 * 확인된 디렉터리에 쓸 수 있어야 하므로, 그것은 root 뿐이며 신뢰의 기준점 자체다.
 *
 * `over` 는 **관측과 소켓 생성만** 바꾼다. 걷기도 정책도 어느 경우에나 돌고, 게이트를
 * 끄는 플래그는 없다. 운영 호출부(`run.ts`)는 이 인자를 넘기지 않는다.
 */
export function createUnixSocketRequest(
    socketPath: string,
    timeoutMs = 5_000,
    over?: {
        provisioning?: ManagedProvisioningDeps;
        connect?: (path: string) => Socket;
    },
): LauncherClientDeps {
    const provisioning = over?.provisioning ?? defaultProvisioningDeps;
    const openSocket = over?.connect ?? connect;
    return {
        request: (payload, options) => {
            if (options?.mode === 'hello') return new Promise<string>((resolve, reject) => {
                const deadline = performance.now() + HELLO_DEADLINE_MS;
                let socket: Socket | undefined;
                let settled = false;
                const frame = Buffer.alloc(HELLO_MAX_FRAME_BYTES);
                let length = 0;
                const overdue = () => performance.now() >= deadline;
                const finish = (error: Error | null, value?: string) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (socket) {
                        socket.removeListener('connect', onConnect);
                        socket.removeListener('data', onData);
                        socket.removeListener('error', onError);
                        socket.removeListener('close', onClose);
                        // A queued socket error after destroy must not become unhandled.
                        socket.on('error', () => {});
                        socket.destroy();
                    }
                    if (!error && overdue()) error = new HelloTransportError('timeout');
                    if (error) reject(error); else resolve(value ?? '');
                };
                const onConnect = () => {
                    if (settled) return;
                    if (overdue()) { finish(new HelloTransportError('timeout')); return; }
                    try { socket!.write(payload); } catch { finish(new Error('transport')); }
                };
                const onData = (chunk: Buffer) => {
                    if (settled) return;
                    const newline = chunk.indexOf(10);
                    const bytes = newline < 0 ? chunk.length : newline;
                    if (length + bytes > HELLO_MAX_FRAME_BYTES) { finish(new HelloTransportError('response-too-large')); return; }
                    chunk.copy(frame, length, 0, bytes);
                    length += bytes;
                    if (newline < 0) return;
                    let decoded: string;
                    try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(frame.subarray(0, length)); }
                    catch { finish(new HelloTransportError('malformed-response')); return; }
                    finish(null, decoded);
                };
                const onError = () => finish(new Error('transport'));
                const onClose = () => finish(new Error('transport'));
                const timer = setTimeout(() => finish(new HelloTransportError('timeout')), HELLO_DEADLINE_MS);
                try {
                    if (trustedPathRefusal(dirname(socketPath), 0, 'not-root-owned', provisioning)) {
                        finish(new LauncherPathUntrustedError()); return;
                    }
                    if (overdue()) { finish(new HelloTransportError('timeout')); return; }
                    socket = openSocket(socketPath);
                    socket.on('connect', onConnect);
                    socket.on('data', onData);
                    socket.on('error', onError);
                    socket.on('close', onClose);
                } catch { finish(new Error('transport')); }
            });
            return new Promise((resolve, reject) => {
            // 연결 **전에**, 매번.
            if (trustedPathRefusal(dirname(socketPath), 0, 'not-root-owned', provisioning)) {
                // 진단은 버린다: 그 안에 경로가 있다.
                reject(new LauncherPathUntrustedError());
                return;
            }
            const socket = openSocket(socketPath);
            let buffer = '';
            const finish = (error: Error | null, value?: string) => {
                socket.destroy();
                if (error) reject(error);
                else resolve(value ?? '');
            };
            socket.setTimeout(timeoutMs, () => finish(new Error('timeout')));
            socket.setEncoding('utf8');
            socket.on('connect', () => { socket.write(payload); });
            socket.on('data', (chunk: string) => {
                buffer += chunk;
                const newline = buffer.indexOf('\n');
                if (newline >= 0) finish(null, buffer.slice(0, newline));
            });
            socket.on('error', (error) => finish(error));
            socket.on('close', () => { if (buffer.indexOf('\n') < 0) finish(new Error('closed')); });
            });
        },
    };
}
