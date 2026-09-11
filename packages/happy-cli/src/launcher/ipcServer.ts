/**
 * specs/managed-cloud-byos §5.36 — supervisor 의 IPC 경계.
 *
 * daemon 은 **client 일 뿐 권한 주체가 아니다.** 여기로 들어오는 요청은 세대를
 * 지목할 수 있을 뿐, 무엇을 어떤 uid 로 어디서 실행할지 고르지 못한다 — 그 값들은
 * supervisor 설정에서만 온다.
 *
 * Unix STREAM 소켓을 쓴다. Node 에는 `SO_PEERCRED` 가 없으므로 상대를 두 가지로
 * 가린다: 소켓이 놓인 디렉터리의 권한(운영이 `0710 root:saycode-daemon` 로 만든다.
 * `0700` 은 daemon 의 traversal 까지 막아 쓸 수 없다), 그리고 부팅마다 새로 만드는
 * 토큰. 토큰은 `timingSafeEqual` 로 비교한다.
 *
 * 요청 본문은 상한을 두고 줄 단위로 읽는다. 상한 없이 모으면 소켓 하나가 임의
 * 크기 입력이 된다.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, chownSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { MANAGED_TARGET_MAX_BASE64 } from '@/managed/checkpoint/managedProviderStateScope';
import { MANAGED_BOOTSTRAP_MAX_BYTES } from '@/managed/managedSpawnBootstrap';

import type { GenerationKey } from './generationManifest';

/** bootstrap 을 싣지 않는 명령의 상한. */
export const MAX_REQUEST_BYTES = 8192;

export type IpcRequest =
    | { op: 'hello'; token: string }
    | { op: 'prove-stopped'; token: string; key: GenerationKey }
    /** runtime 전체 질문이다. run/attempt 로 좁히지 않는다. */
    | { op: 'prove-below'; token: string; belowEpoch: number }
    | { op: 'request-stop'; token: string; key: GenerationKey }
    /**
     * 1단계. bootstrap 은 **바이트로** 온다 — Node 에 `SCM_RIGHTS` 가 없어
     * FD 번호를 프로세스 사이로 넘길 수 없고, 경로를 받으면 caller 가 무엇을
     * 읽힐지 고르게 된다. supervisor 가 자기 소유 디렉터리에 놓고 **자기가 연
     * FD** 를 helper 에 상속시킨다.
     */
    | {
        op: 'prepare-launch';
        token: string;
        key: GenerationKey;
        leaseExpiresMonotonic: number;
        bootstrapBase64: string;
        /** 이 launch 의 보고 자격. 봉투와 **다른** 문서다 — 부모 서명 경계 밖. */
        reportCredentialBase64: string;
    }
    /** 2단계. 등록이 끝났으니 놓아준다. handle 은 일회용이다. */
    | { op: 'release-launch'; token: string; handle: string }
    | { op: 'renew'; token: string; key: GenerationKey; renewalSeq: number; leaseExpiresMonotonic: number }
    /**
     * 부모가 발급한 checkpoint target 을 supervisor 로 넘긴다.
     *
     * RPC 는 daemon 이 받지만 inbox 는 supervisor 프로세스에 있다 — checkpoint
     * runner 가 tool session 과 **같은 drain 객체**를 공유해야 하고, 두 프로세스는
     * 메모리를 공유하지 않는다. 그래서 이 소켓이 그 경계다.
     *
     * bootstrap 봉투와 같은 이유로 **바이트로** 온다: 안에 한 체크포인트짜리 키와
     * 서명된 URL 이 들어 있어 경로로 받으면 caller 가 무엇을 읽힐지 고르게 된다.
     */
    /**
     * `dispatchToken` 은 bearer 와 **다른 일을 하는 다른 값**이다. bearer 는
     * *이 caller 가 이 소켓에서 말해도 된다*고 말하고, dispatch token 은
     * *부모가 이 문서에 서명했다*고 말한다. 서로 비교되지 않으며, bearer 를
     * 쥔 daemon 도 두 번째를 위조하지 못한다.
     */
    | { op: 'checkpoint-target'; token: string; targetBase64: string; dispatchToken: string }
    /**
     * runtime 전체에 대한 부모의 lease 진술. 세대를 지목하지 않는다 —
     * 부모가 실제로 보내는 lease 는 이것뿐이고, 창을 넓히는 대상은 이 runtime 의
     * **모든** 세대다.
     *
     * `renew` 와 다른 일이다. `renew` 는 daemon 이 계산한 deadline 을 세대별로
     * 옮기고, 이것은 부모가 서명한 진술 자체를 나른다. 이 증분은 `renew` 를
     * 건드리지 않는다.
     */
    | { op: 'grant'; token: string; paramsBase64: string; dispatchToken: string };

export type IpcResponse =
    | { ok: true; result: unknown }
    | { ok: false; reason: string };

/** A live memory observation, not a lease or isolation authority. */
export type SupervisorHello = {
    instanceNonce: string;
    runtimeId: string;
    provisioningOperationId: string;
    markerSha256: string;
};

export function parseSupervisorHello(value: unknown): SupervisorHello | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const fields = ['instanceNonce', 'runtimeId', 'provisioningOperationId', 'markerSha256'];
    if (Object.keys(record).length !== fields.length
        || !fields.every((field) => Object.prototype.hasOwnProperty.call(record, field))) return null;
    const { instanceNonce, runtimeId, provisioningOperationId, markerSha256 } = record;
    const isIdentity = (id: unknown): id is string => typeof id === 'string'
        && id.length > 0 && id.length <= 200 && id.trim() === id;
    if (typeof instanceNonce !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(instanceNonce)
        || typeof markerSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(markerSha256)
        || !isIdentity(runtimeId) || !isIdentity(provisioningOperationId)) return null;
    return { instanceNonce, runtimeId, provisioningOperationId, markerSha256 };
}

export type IpcHandlers = {
    hello?: () => SupervisorHello | null;
    proveStopped: (key: GenerationKey) => { proven: boolean; detail?: string };
    proveBelow: (input: { belowEpoch: number }) => { proven: boolean; detail: string };
    requestStop: (key: GenerationKey) => { requested: boolean; detail: string }
        | Promise<{ requested: boolean; detail: string }>;
    prepareLaunch: (input: {
        key: GenerationKey;
        leaseExpiresMonotonic: number;
        bootstrap: Buffer;
        /** 자식에게 별도 fd 로 넘길 보고 자격. env 나 argv 로는 가지 않는다. */
        reportCredential: Buffer;
    }) => Promise<{ prepared: true; pid: number | null; handle: string }
        | { prepared: false; detail: string }>;
    releaseLaunch: (handle: string) => Promise<{ released: boolean; detail: string }>;
    renew: (input: { key: GenerationKey; renewalSeq: number; leaseExpiresMonotonic: number }) =>
        { renewed: boolean; detail?: string };
    /** 발급된 target 을 supervisor 의 inbox 에 넣는다. */
    /**
     * 발급된 target 을 supervisor 의 inbox 에 넣고, **무엇이 일어날지**를 함께
     * 답한다. 수락은 이 hop 이 끝났다는 뜻일 뿐이고, 아카이브가 뒤따르는지는
     * `state` 가 말한다 — 그 둘을 하나로 접으면 아카이브가 없는데 있다고
     * 보고하게 된다.
     */
    acceptCheckpointTarget?: (target: Buffer, dispatchToken: string)
        => { accepted: boolean; state?: string; detail?: string };
    /**
     * 부모가 서명한 runtime lease 를 그대로 받아 기록한다.
     *
     * 대답은 **관측했는가**이지 집행했는가가 아니다. daemon 은 이 거절을
     * `renewal-not-enforced` 로 올리고 아무것도 쓰지 않는다.
     */
    acceptRuntimeGrant?: (params: Buffer, dispatchToken: string)
        => { admitted: boolean; detail?: string };
};

/**
 * dispatch token 의 문자 상한. `managedDispatchToken.ts` 의 `MAX_TOKEN_BYTES`
 * 와 같은 값이며 그 검증기도 같은 상한을 자기 몫으로 다시 본다 — 여기 값은
 * 그 검증기에 닿기 전에 frame 을 재기 위한 것이지, 그 검증을 대신하지 않는다.
 */
const MAX_DISPATCH_TOKEN_CHARS = 4096;

/**
 * base64url 두 조각과 점 하나. **크기를 재기 전에** 본다: `.length` 는 UTF-16
 * 단위를 세는데 JSON 은 제어문자를 `\uXXXX` 로 6바이트에 싣는다. 즉 문자 상한을
 * 통과한 토큰이 frame 에는 6배로 실릴 수 있다. 이 알파벳 안에서는 문자·UTF-8
 * 바이트·직렬화 바이트가 모두 같아져, 아래 합이 실제 상한이 된다.
 */
const DISPATCH_TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * checkpoint-target frame 의 상한. 쿠션이 아니라 이름 붙은 몫의 합이다:
 *
 *   74        빈 표준 봉투 `{"op":…,"token":"","targetBase64":"","dispatchToken":""}` 실측
 *   349,528   `MANAGED_TARGET_MAX_BASE64`
 *   4,096     dispatch token — 알파벳이 고정되어 문자 = 바이트
 *   3,072     bearer — `MAX_TOKEN_LENGTH` 512 UTF-16 단위 × `\uXXXX` 6바이트
 *
 * 필드 하나가 각자의 상한을 지켜도 합이 넘으면 거부한다. 전체 frame 한도
 * (`MAX_ENCODED_REQUEST_BYTES`), generic 8KiB, bootstrap 2MiB 는 그대로다.
 */
export const MANAGED_CHECKPOINT_FRAME_MAX_BYTES = 74 + MANAGED_TARGET_MAX_BASE64
    + MAX_DISPATCH_TOKEN_CHARS + 6 * 512;

/**
 * grant params 문서의 상한, **디코드된 바이트로**. runtime-lease params 는
 * `{requestedMs}` 하나이므로 1KiB 는 60배 넉넉하며, 오늘의 필드 이름에 맞춘 값이
 * 아니다 — 필드가 하나 늘었다고 규격 안의 grant 가 조용히 넘어가면 안 된다.
 */
export const MANAGED_GRANT_PARAMS_MAX_BYTES = 1024;

/**
 * 같은 상한의 base64 폭, frame 을 디코드 **전에** 재기 위한 것이다.
 *
 * 이것만으로는 위의 계약이 서지 않는다: 1,368자는 최대 **1,026**바이트로
 * 디코드되므로 1,025·1,026바이트 문서가 통과한다. 진짜 경계는 디코드된 바이트를
 * parse 하기 **전에** 보는 쪽이고(`composeRuntimeGrantHandler`), 이 값은 임의
 * 크기 입력을 먼저 만들지 않기 위한 앞단일 뿐이다.
 */
const MANAGED_GRANT_PARAMS_MAX_BASE64 = 4 * Math.ceil(MANAGED_GRANT_PARAMS_MAX_BYTES / 3);

/**
 * grant frame 의 상한. checkpoint 와 같은 방식의 합이다:
 *
 *   62      빈 표준 봉투 `{"op":"grant","token":"","dispatchToken":"","paramsBase64":""}` 실측
 *   1,368   `MANAGED_GRANT_PARAMS_MAX_BASE64`
 *   4,096   dispatch token — 알파벳이 고정되어 문자 = 바이트
 *   3,072   bearer — 512 UTF-16 단위 × `\uXXXX` 6바이트
 *
 * generic 8KiB 를 넘으므로 이 op 전용이다. bootstrap 2MiB 와 전체 frame 한도는
 * 그대로다.
 */
export const MANAGED_GRANT_FRAME_MAX_BYTES = 62 + MANAGED_GRANT_PARAMS_MAX_BASE64
    + MAX_DISPATCH_TOKEN_CHARS + 6 * 512;

/**
 * bootstrap 봉투의 상한(2MiB)은 B2 계약값이다. base64 는 4/3 배로 늘고 JSON
 * 따옴표·필드가 더 붙으므로, 인코딩된 요청은 그만큼 더 허용해야 한다 —
 * 상한을 봉투 크기로 잡으면 규격 안의 봉투가 거부된다.
 */
export const MAX_BOOTSTRAP_BYTES = MANAGED_BOOTSTRAP_MAX_BYTES;
export const MAX_ENCODED_REQUEST_BYTES = Math.ceil(MANAGED_BOOTSTRAP_MAX_BYTES * 4 / 3) + 8192;

function isSafeId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function isEpoch(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readKey(value: unknown): GenerationKey | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (!isSafeId(record.runId) || !isSafeId(record.attemptId) || !isEpoch(record.epoch)) return null;
    return { runId: record.runId, attemptId: record.attemptId, epoch: record.epoch };
}

/** 토큰 비교는 길이 차이도 시간으로 새지 않게 다룬다. */
export function tokensMatch(expected: string, received: unknown): boolean {
    if (typeof received !== 'string') return false;
    const left = Buffer.from(expected, 'utf8');
    const right = Buffer.from(received, 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

export async function handleIpcRequest(input: {
    raw: string;
    token: string;
    handlers: IpcHandlers;
}): Promise<IpcResponse> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(input.raw);
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'malformed' };
    }
    const request = parsed as Record<string, unknown>;
    // 토큰을 먼저 본다. 인증 전에 op 별 분기를 타면 그 자체가 정보가 된다.
    if (!tokensMatch(input.token, request.token)) return { ok: false, reason: 'unauthorized' };

    switch (request.op) {
        case 'hello': {
            if (Object.keys(request).length !== 2) return { ok: false, reason: 'malformed' };
            const result = parseSupervisorHello(input.handlers.hello?.());
            return result ? { ok: true, result } : { ok: false, reason: 'hello-unavailable' };
        }
        case 'prove-stopped': {
            const key = readKey(request.key);
            if (!key) return { ok: false, reason: 'malformed' };
            return { ok: true, result: input.handlers.proveStopped(key) };
        }
        case 'prove-below': {
            if (!isEpoch(request.belowEpoch)) return { ok: false, reason: 'malformed' };
            return { ok: true, result: input.handlers.proveBelow({ belowEpoch: request.belowEpoch }) };
        }
        case 'request-stop': {
            const key = readKey(request.key);
            if (!key) return { ok: false, reason: 'malformed' };
            return { ok: true, result: await input.handlers.requestStop(key) };
        }
        case 'prepare-launch': {
            const key = readKey(request.key);
            if (!key || !isEpoch(request.leaseExpiresMonotonic)
                || typeof request.bootstrapBase64 !== 'string'
                || typeof request.reportCredentialBase64 !== 'string') {
                return { ok: false, reason: 'malformed' };
            }
            // 디코드 전에 크기를 본다. 임의 크기 입력을 먼저 만들지 않는다.
            if (request.bootstrapBase64.length > MAX_ENCODED_REQUEST_BYTES) {
                return { ok: false, reason: 'too-large' };
            }
            const bootstrap = Buffer.from(request.bootstrapBase64, 'base64');
            if (bootstrap.length === 0 || bootstrap.length > MAX_BOOTSTRAP_BYTES) {
                return { ok: false, reason: 'malformed' };
            }
            if (request.reportCredentialBase64.length > MAX_REQUEST_BYTES) {
                return { ok: false, reason: 'too-large' };
            }
            const reportCredential = Buffer.from(request.reportCredentialBase64, 'base64');
            // 자격 없이 띄우면 그 자식의 보고는 전부 거부된다 — 띄우지 않는다.
            if (reportCredential.length === 0) return { ok: false, reason: 'malformed' };
            return {
                ok: true,
                result: await input.handlers.prepareLaunch({
                    key,
                    leaseExpiresMonotonic: request.leaseExpiresMonotonic,
                    bootstrap,
                    reportCredential,
                }),
            };
        }
        case 'release-launch': {
            if (typeof request.handle !== 'string' || !/^[0-9a-f]{32}$/.test(request.handle)) {
                return { ok: false, reason: 'malformed' };
            }
            return { ok: true, result: await input.handlers.releaseLaunch(request.handle) };
        }
        case 'renew': {
            const key = readKey(request.key);
            if (!key || !isEpoch(request.renewalSeq) || !isEpoch(request.leaseExpiresMonotonic)) {
                return { ok: false, reason: 'malformed' };
            }
            return {
                ok: true,
                result: input.handlers.renew({
                    key, renewalSeq: request.renewalSeq,
                    leaseExpiresMonotonic: request.leaseExpiresMonotonic,
                }),
            };
        }
        case 'checkpoint-target': {
            if (typeof request.targetBase64 !== 'string'
                || typeof request.dispatchToken !== 'string') {
                // 서명 없는 경로는 없다. 검증할 것이 없는 target 은 후보로도
                // 줄에 세우지 않고 경계에서 거부한다.
                return { ok: false, reason: 'malformed' };
            }
            // 알파벳이 먼저다 — 그래야 아래 크기 검사가 아는 것을 잰다.
            if (request.dispatchToken.length > MAX_DISPATCH_TOKEN_CHARS
                || !DISPATCH_TOKEN_SHAPE.test(request.dispatchToken)) {
                return { ok: false, reason: 'malformed' };
            }
            if (Buffer.byteLength(input.raw, 'utf8') > MANAGED_CHECKPOINT_FRAME_MAX_BYTES) {
                return { ok: false, reason: 'too-large' };
            }
            /*
             * 디코드 **전에** 크기를 본다. 봉투와 같은 규칙 — 임의 크기 입력을
             * 먼저 만들지 않는다.
             *
             * 다만 한도는 이 op 전용이다. target 이 이제 provider-state scope 를
             * 싣기 때문이다: 실제 presigned URL 로 재 보면 source 11개는 base64
             * 7,964자로 일반 8KiB 한도 **안에** 들어가고 12개가 8,244자로 넘는다.
             * 즉 작은 target 은 지금도 통과하며, 막히는 것은 이력이다.
             *
             * 넓히는 것은 이 한 op 뿐이다 — generic 8KiB, bootstrap 2MiB, 전체
             * frame 한도는 그대로다.
             */
            if (request.targetBase64.length > MANAGED_TARGET_MAX_BASE64) {
                return { ok: false, reason: 'too-large' };
            }
            const target = Buffer.from(request.targetBase64, 'base64');
            if (target.length === 0) return { ok: false, reason: 'malformed' };
            if (!input.handlers.acceptCheckpointTarget) {
                // 이 runtime 은 checkpoint 를 하지 않는다. 받아 두고 아무도 쓰지
                // 않으면 발급된 자격이 조용히 만료된다.
                return { ok: false, reason: 'checkpoint-unconfigured' };
            }
            return {
                ok: true,
                result: input.handlers.acceptCheckpointTarget(target, request.dispatchToken),
            };
        }
        case 'grant': {
            if (typeof request.paramsBase64 !== 'string'
                || typeof request.dispatchToken !== 'string') {
                return { ok: false, reason: 'malformed' };
            }
            // 알파벳이 먼저다 — 그래야 크기 검사가 아는 것을 잰다.
            if (request.dispatchToken.length > MAX_DISPATCH_TOKEN_CHARS
                || !DISPATCH_TOKEN_SHAPE.test(request.dispatchToken)) {
                return { ok: false, reason: 'malformed' };
            }
            if (Buffer.byteLength(input.raw, 'utf8') > MANAGED_GRANT_FRAME_MAX_BYTES) {
                return { ok: false, reason: 'too-large' };
            }
            if (request.paramsBase64.length > MANAGED_GRANT_PARAMS_MAX_BASE64) {
                return { ok: false, reason: 'too-large' };
            }
            const params = Buffer.from(request.paramsBase64, 'base64');
            if (params.length === 0) return { ok: false, reason: 'malformed' };
            if (!input.handlers.acceptRuntimeGrant) {
                // 없음은 수락이 아니다. 기록할 곳이 없는 grant 를 받아들이면
                // 부모는 아무도 관측하지 않은 진술을 ACK 받는다.
                return { ok: false, reason: 'grant-unconfigured' };
            }
            return {
                ok: true,
                result: input.handlers.acceptRuntimeGrant(params, request.dispatchToken),
            };
        }
        default:
            return { ok: false, reason: 'unsupported-op' };
    }
}

/**
 * 소켓 파일 권한. 디렉터리는 운영이 `0710 root:saycode-daemon` 으로 만든다
 * (`0700` 은 daemon 의 traversal 까지 막아 쓸 수 없다). 소켓 자체는 소유자와
 * 그룹만 열 수 있어야 하며, 다른 로컬 사용자에게 열려 있으면 안 된다.
 */
export const SOCKET_MODE = 0o660;

/** 한 요청의 시한. 열어만 두고 말하지 않는 client 가 소켓을 붙잡지 못하게 한다. */
export const REQUEST_TIMEOUT_MS = 10_000;

export function createIpcServer(input: {
    socketPath: string;
    handlers: IpcHandlers;
    /**
     * daemon 이 속한 신뢰 그룹의 gid.
     *
     * 디렉터리를 `root:daemon 0710` 으로 만들어도 **그 안에 생긴 소켓은
     * `root:root`** 다. mode 만 `0660` 으로 바꾸면 group 은 여전히 root 이라
     * 비root daemon 은 EACCES 를 받는다. 그래서 소켓 자체의 group 을 옮긴다.
     *
     * 주지 않으면 소켓은 소유자만 열 수 있는 상태로 남는다 — 열어 두는 것보다
     * 낫고, 그 경우 비root daemon 은 연결하지 못한다.
     */
    daemonGid?: number;
    token?: string;
}): {
    server: Server;
    token: string;
    listen: () => Promise<void>;
    /**
     * 입구를 닫고 **진행 중 요청이 끝날 때까지** 기다린다.
     *
     * `server.close()` 는 새 연결만 막고 이미 실행 중인 handler 는 기다리지
     * 않는다. 소켓이 시한으로 끊겨도 handler 는 계속 돌기 때문에, 그것만 믿으면
     * 종료가 끝난 뒤에 늦은 `prepare-launch` 가 세대를 만들어 park 시킨다.
     */
    close: () => Promise<void>;
} {
    const token = input.token ?? randomBytes(32).toString('base64url');
    let closing = false;
    let inFlight = 0;
    let drained: (() => void) | null = null;
    const settleDrain = () => {
        if (closing && inFlight === 0 && drained) {
            const done = drained;
            drained = null;
            done();
        }
    };
    const server = createServer((socket: Socket) => {
        let buffer = '';
        // **소켓 하나에 요청 하나.** 첫 줄 뒤의 데이터는 읽지 않는다 — 같은
        // 소켓에서 두 요청이 겹치면 두 번째가 첫 번째의 응답을 받는다.
        let taken = false;
        socket.setEncoding('utf8');
        // 말이 없거나 줄을 끝내지 않는 client 를 무한정 기다리지 않는다.
        socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
            if (!taken) socket.end(`${JSON.stringify({ ok: false, reason: 'timeout' })}\n`);
            socket.destroy();
        });
        socket.on('data', (chunk: string) => {
            if (taken) return;
            buffer += chunk;
            if (Buffer.byteLength(buffer, 'utf8') > MAX_ENCODED_REQUEST_BYTES) {
                taken = true;
                socket.end(`${JSON.stringify({ ok: false, reason: 'too-large' })}\n`);
                return;
            }
            const newline = buffer.indexOf('\n');
            if (newline < 0) return;
            taken = true;
            const raw = buffer.slice(0, newline);
            buffer = '';
            // 종료가 시작된 뒤 도착한 요청은 받지 않는다. 늦은 prepare 가
            // 종료 뒤에 세대를 만드는 것을 막는다.
            if (closing) {
                socket.end(`${JSON.stringify({ ok: false, reason: 'shutting-down' })}\n`);
                return;
            }
            inFlight += 1;
            void handleIpcRequest({ raw, token, handlers: input.handlers }).then(
                (response) => { socket.end(`${JSON.stringify(response)}\n`); },
                // 원문은 옮기지 않는다.
                () => { socket.end(`${JSON.stringify({ ok: false, reason: 'internal' })}\n`); },
            ).finally(() => {
                inFlight -= 1;
                settleDrain();
            });
        });
        socket.on('error', () => { socket.destroy(); });
    });
    return {
        server,
        token,
        listen: () => new Promise<void>((resolve, reject) => {
            // 남은 소켓 파일이 있으면 bind 가 EADDRINUSE 로 막힌다. 지우고 연다.
            try { unlinkSync(input.socketPath); } catch { /* 없으면 그만이다 */ }
            server.once('error', reject);
            server.listen(input.socketPath, () => {
                try {
                    if (input.daemonGid !== undefined) {
                        if (!Number.isSafeInteger(input.daemonGid) || input.daemonGid < 0) {
                            throw new Error('daemonGid must be a non-negative safe integer');
                        }
                        // 소유자는 그대로 두고 group 만 신뢰 그룹으로 옮긴다.
                        chownSync(input.socketPath, statSync(input.socketPath).uid, input.daemonGid);
                    }
                    chmodSync(input.socketPath, SOCKET_MODE);
                } catch (error) {
                    // 권한을 못 걸면 열어 두지 않는다.
                    server.close();
                    reject(error as Error);
                    return;
                }
                resolve();
            });
        }),
        close: async () => {
            closing = true;
            await new Promise<void>((resolve) => { server.close(() => resolve()); });
            // 소켓이 닫혔다고 handler 가 끝난 것은 아니다.
            if (inFlight > 0) {
                await new Promise<void>((resolve) => { drained = resolve; });
            }
        },
    };
}
