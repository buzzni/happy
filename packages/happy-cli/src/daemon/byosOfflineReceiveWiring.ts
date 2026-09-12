/**
 * Everything the BYOS receiver needs, built from what the daemon already has.
 *
 * The receiver decides; this assembles. It exists so the daemon's own file
 * hands over four things it owns — its machine id, its home directory, its
 * account bearer, and how it reaches a session — and nothing else has to be
 * understood at that call site: the store, the configured parent origin, the
 * HTTP authorization call and every classifier live here.
 *
 * **The parent origin comes from configuration, never from a request.** That is
 * the whole basis of the authorization: a delivery may name any actor, and only
 * the parent — reached at an address the operator chose — can say whether that
 * claim matches a row a human actually admitted. A daemon with no configured
 * origin therefore builds **no handlers at all**: registering ones that can only
 * ever hold would make the parent wait for a person on every request, which
 * reads as a stuck queue rather than an unconfigured deployment.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import axios from 'axios';

import { encodeBase64, encrypt } from '@/api/encryption';
import { readMessageAck } from '@/api/apiSession';

import { createByosOfflineReceiptStore } from './byosOfflineReceiptStore';
import {
    createByosOfflineRpcHandlers,
    type ByosDeliverRequest,
    type ByosHostedSession,
    type ByosOfflineAuthorization,
    type ByosOfflineRpcHandlers,
} from './byosOfflineReceive';

/** A session this daemon is tracking, as the daemon's own map records it. */
export type ByosTrackedSessionView = {
    /** Present only once the session reported itself. */
    happySessionId?: string;
    directory?: string;
    pid: number;
    encryption?: {
        encryptionKey: Uint8Array;
        encryptionVariant: 'legacy' | 'dataKey';
    };
};

export type ByosOfflineWiringDeps = {
    machineId: string;
    /** `~/.happy` (or its override). The receipt store lives under it. */
    happyHomeDir: string;
    /** The account bearer this daemon authenticates to the parent with. */
    readAccountToken: () => string | null;
    /**
     * `HAPPY_APLUS_MCP_CONFIG_URL` or equivalent — the **configured** parent.
     * Its origin is used; the path is ignored.
     */
    parentConfigUrl: string | null | undefined;
    /** The daemon's tracked-session lookup. Returns `null` when it holds none. */
    findTrackedSession: (sessionId: string) => ByosTrackedSessionView | null;
    /** Where sessions live — `configuration.serverUrl`. */
    serverUrl: string;
    /**
     * The daemon's existing resume fence. Bypassing it can double-spawn.
     *
     * In `run.ts` this is a member of the follow-up runner's collaborators, not
     * a free function; pass a closure over whatever holds it.
     */
    ensureSessionRunning: (input: { sessionId: string }) => Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** Escape hatch for tests. Production uses `axios.post`. */
    post?: typeof axios.post;
    /**
     * Told when a delivered message could not wake its session.
     *
     * There is **no retry owner** for this: the message stays queued and is
     * picked up whenever that session next runs. This exists so the failure is
     * visible rather than swallowed, not because something reacts to it.
     */
    onWakeFailed?: (input: { sessionId: string; reason: string }) => void;
    fetch?: typeof fetch;
    /** Bounded so one unreachable parent cannot hold a handler open. */
    timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MESSAGE_POST_TIMEOUT_MS = 60_000;
const AUTHORIZE_PATH = '/api/byos-offline/authorize';

/**
 * The text a queued request carries, or `null` when it is not one.
 *
 * The producer seals `{t: 'user-text', text}`. Anything else is a shape this
 * daemon does not know how to hand to a session, and guessing would put
 * whatever it is into the transcript as if a person had typed it.
 */
export function readUserText(body: unknown): string | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const raw = body as Record<string, unknown>;
    if (raw.t !== 'user-text') return null;
    return typeof raw.text === 'string' && raw.text !== '' ? raw.text : null;
}

/** The origin of a configured URL, or `null` when there is nothing usable. */
export function readByosParentOrigin(configUrl: string | null | undefined): string | null {
    if (typeof configUrl !== 'string' || configUrl.trim() === '') return null;
    try {
        const parsed = new URL(configUrl);
        // 이 경로로 자격이 나간다. 평문 http 는 loopback 에서만 허용한다.
        if (parsed.protocol !== 'https:'
            && parsed.hostname !== 'localhost'
            && parsed.hostname !== '127.0.0.1') return null;
        return parsed.origin;
    } catch {
        return null;
    }
}

/**
 * Asks the parent, over HTTP, whether one delivery may take effect.
 *
 * Only two answers are settled: an authorization and a refusal the parent
 * states. Everything else — no bearer, a transport failure, a 5xx, a body that
 * does not parse — is `unknown`, because none of them mean "not allowed", and a
 * refusal would send the row back to be tried again.
 */
export function createByosOfflineAuthorizer(
    deps: Pick<ByosOfflineWiringDeps, 'readAccountToken' | 'fetch' | 'timeoutMs'>
    & { origin: string },
): (request: ByosDeliverRequest) => Promise<ByosOfflineAuthorization> {
    const call = deps.fetch ?? fetch;
    return async (request) => {
        const token = deps.readAccountToken();
        if (token === null || token === '') {
            return { kind: 'unknown', reason: 'parent-credential-missing' };
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        let response: Response;
        try {
            response = await call(`${deps.origin}${AUTHORIZE_PATH}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                    'X-Aplus-Machine-Id': request.machineId,
                },
                body: JSON.stringify({
                    actorUserId: request.actorUserId,
                    requestKey: request.requestKey,
                    claimId: request.claimId,
                    projectId: request.projectId,
                    sessionId: request.sessionId,
                    machineId: request.machineId,
                    bindingVersion: request.bindingVersion,
                    ciphertextDigest: request.ciphertextDigest,
                }),
                signal: controller.signal,
            });
        } catch {
            clearTimeout(timer);
            // 닿지 못한 것은 불허가 아니다.
            return { kind: 'unknown', reason: 'authorization-unreachable' };
        }
        if (response.status === 401 || response.status === 403) {
            clearTimeout(timer);
            /*
             * 이 daemon 의 자격이 그 부모에게 받아들여지지 않았다. 요청의 잘못이
             * 아니므로 보류다 — 거절로 접으면 설정이 잘못된 동안 큐가 계속 돈다.
             */
            return { kind: 'unknown', reason: 'parent-rejected-credential' };
        }
        /*
         * **본문까지 같은 시한 아래 읽는다.** 헤더가 왔다고 시계를 끄면, 본문을
         * 흘리다 마는 서버 하나가 이 handler 를 끝없이 붙잡는다 — abort 신호는
         * 이미 진행 중인 읽기에도 걸린다.
         */
        let body: unknown;
        try {
            body = await response.json();
        } catch {
            return { kind: 'unknown', reason: 'authorization-unreadable' };
        } finally {
            clearTimeout(timer);
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return { kind: 'unknown', reason: 'authorization-unreadable' };
        }
        const raw = body as Record<string, unknown>;
        const reason = typeof raw.reason === 'string' && raw.reason.trim() !== ''
            ? raw.reason.trim()
            : 'unknown';
        if (response.ok && raw.kind === 'authorized') return { kind: 'authorized' };
        if (response.ok && raw.kind === 'refused') return { kind: 'refused', reason };
        return { kind: 'unknown', reason };
    };
}

/**
 * The handlers, or `undefined` when this daemon has no configured parent.
 *
 * `undefined` is the honest answer for an unconfigured deployment: the caller
 * registers nothing, and the parent's own view says auto-delivery is not
 * enabled rather than that every request is stuck.
 */
export function createByosOfflineReceiveWiring(
    deps: ByosOfflineWiringDeps,
): ByosOfflineRpcHandlers | undefined {
    const origin = readByosParentOrigin(deps.parentConfigUrl);
    if (origin === null) return undefined;

    const findHostedSession = (sessionId: string): ByosHostedSession | null => {
        const tracked = deps.findTrackedSession(sessionId);
        /*
         * 키가 없으면 그 세션을 **들고 있다고 말할 수 없다.** 아직 자기를 알리지
         * 않았거나 복구 중일 수 있고, 그 상태로 받은 봉투는 열지 못한다.
         */
        if (!tracked?.encryption) return null;
        return {
            encryptionKey: tracked.encryption.encryptionKey,
            encryptionVariant: tracked.encryption.encryptionVariant,
            /*
             * 같은 sessionId 라도 다시 태어난 세션은 **다른 수신자**다. pid 는
             * 그 전환마다 바뀌므로 세대 표시로 쓴다.
             */
            incarnation: String(tracked.pid),
        };
    };

    return createByosOfflineRpcHandlers({
        machineId: deps.machineId,
        store: createByosOfflineReceiptStore(join(deps.happyHomeDir, 'byos-offline')),
        findHostedSession,
        authorize: createByosOfflineAuthorizer({
            origin,
            readAccountToken: deps.readAccountToken,
            ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
            ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        }),
        submitToSession: async ({ sessionId, session, body }) => {
            const token = deps.readAccountToken();
            if (token === null || token === '') {
                return { ok: false, reason: 'session-credential-missing' };
            }
            /*
             * **모양을 옮긴다.** 화면이 봉인한 것은 `{t:'user-text', text}` 이고,
             * 세션이 사용자 메시지로 읽는 것은 `UserMessageSchema` — 즉
             * `{role:'user', content:{type:'text',text}}` 다(`api/types.ts:265`,
             * 소비는 `apiSession.ts:891`). 받은 것을 그대로 다시 봉인하면 바이트는
             * 멀쩡한데 세션이 그것을 사용자 입력으로 보지 않는다.
             */
            const text = readUserText(body);
            if (text === null) return { ok: false, reason: 'unsupported-body' };

            const localId = randomUUID();
            const content = encodeBase64(encrypt(
                session.encryptionKey,
                session.encryptionVariant,
                {
                    role: 'user',
                    content: { type: 'text', text },
                    localKey: localId,
                    meta: { sentFrom: 'daemon', source: 'byos-offline' },
                },
            ));

            /*
             * daemon 이 세션에 사용자 메시지를 넣는 **기존 경로** 그대로다
             * (`daemon/autonomousQualityGateMessageSender.ts:33-45`).
             */
            const post = deps.post ?? axios.post;
            let response: unknown;
            try {
                response = await post(
                    `${deps.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`,
                    { messages: [{ localId, content }] },
                    {
                        headers: {
                            Authorization: `Bearer ${token ?? ''}`,
                            'Content-Type': 'application/json',
                            'X-Happy-Client': 'cli-daemon/byos-offline',
                        },
                        timeout: MESSAGE_POST_TIMEOUT_MS,
                    },
                );
            } catch {
                // 보냈는지 아닌지 모른다 — 원문은 옮기지 않는다.
                return { ok: false, reason: 'message-post-failed' };
            }

            /*
             * **서버가 이 메시지를 실제로 기록했는가.** 200 이라는 사실이 아니라
             * 응답이 우리 `localId` 를 seq 와 함께 되돌려 준 것이 승인이다 —
             * 같은 판정을 세션 클라이언트도 쓴다(`apiSession.ts:124`).
             */
            const rows = (response as { data?: { messages?: unknown } } | null)?.data?.messages;
            const ack = readMessageAck(rows, localId);
            if (!ack.ok) {
                return { ok: false, reason: ack.reason === 'absent' ? 'ack-absent' : 'ack-contradictory' };
            }

            /*
             * 메시지는 기록됐다. 세션을 깨우지 못한 것은 **전달 실패가 아니라**
             * 그 뒤의 일이므로 여기서 실패로 답하면 이미 들어간 메시지가 다시
             * 보내진다.
             *
             * **누가 다시 깨우는지는 정해져 있지 않다.** 이 경로에는 재시도
             * 주인이 없고, 여기서 하나 지어내면 아무도 검토하지 않은 스케줄이
             * 생긴다. 그래서 하는 일은 하나뿐이다 — 조용히 넘기지 않고 알린다.
             * 그 메시지는 세션이 다음에 깨어날 때(사람이 열든, 다른 경로가 깨우든)
             * 큐에 그대로 남아 있다.
             */
            /*
             * **디렉터리를 여기서 요구하지 않는다.** 재개는 세션 id 하나로
             * 충분하고(그 fence 가 metadata.path 를 스스로 읽는다), 추운 재시작
             * 뒤 복원된 세션에는 그 필드가 없다 — 그것을 문으로 세우면 키도
             * 있고 메시지도 들어간 세션이 영영 깨어나지 못한다.
             */
            try {
                const woke = await deps.ensureSessionRunning({ sessionId });
                if (!woke.ok) {
                    deps.onWakeFailed?.({ sessionId, reason: woke.error ?? 'resume-refused' });
                }
            } catch {
                deps.onWakeFailed?.({ sessionId, reason: 'resume-threw' });
            }
            return { ok: true };
        },
    });
}
