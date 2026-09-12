/**
 * Receiving one BYOS offline dispatch on the machine that hosts the session.
 *
 * Two RPCs. `confirm-session-host` answers whether this daemon is holding a
 * session **right now** — routing says where a request goes, not who has it,
 * and the parent needs the second fact before it sends a sealed body. `deliver`
 * carries that body.
 *
 * ## What this daemon can and cannot prove
 *
 * A machine-scoped RPC proves that the caller holds a token for this machine's
 * Happy account and the machine key. Both are shared by every client of the
 * account, so `actorUserId` in a request is a **claim**, not an identity — and
 * the sealed body proves no more, because the session key is shared with
 * everyone who can read the session. Nothing here can tell those apart.
 *
 * So the actor is never treated as authority locally. Before the side effect,
 * the parent is asked — over a **configured** origin, never one the request
 * supplied — whether this exact delivery may take effect, and the parent
 * answers from the row its own authenticated admission created, with the ACL
 * as it stands now. An unconfigured origin is a closed door, not an open one.
 *
 * ## Three answers, kept apart
 *
 * `accepted` means it took effect. `refused` means it did not and will not —
 * the parent may return the request to its queue. `unknown` means nobody can
 * say, and the parent must hold it for a person. Folding `unknown` into either
 * neighbour is how work is silently lost or silently repeated, so every failure
 * here is classified deliberately, and the record is written **before** the
 * side effect so a crash leaves `unknown` rather than "never happened".
 */
import { createHash } from 'node:crypto';

import { decodeBase64, decrypt } from '@/api/encryption';

import {
    createByosOfflineReceiptStore,
    type ByosOfflineIntent,
} from './byosOfflineReceiptStore';

/** The session this daemon holds, as far as it can tell. */
export type ByosHostedSession = {
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    /**
     * Which incarnation of that session this is.
     *
     * A session id can come back — resumed, respawned — and the process behind
     * it is then a different recipient. Something that changes with it (the
     * child's pid, say) is what tells "still the one we confirmed" from "the
     * same name, a different process".
     */
    incarnation: string;
};

export type ByosConfirmHostRequest = {
    machineId: string;
    sessionId: string;
    actorUserId: string;
};

export type ByosConfirmHostReply =
    | { kind: 'hosting' }
    | { kind: 'not-hosting'; reason: string }
    | { kind: 'unknown'; reason: string };

export type ByosDeliverRequest = ByosOfflineIntent & {
    /** Identifies which attempt an answer belongs to. Never the dedupe key. */
    claimId: string;
    /** Present on the wire; recomputed here rather than trusted. */
    payloadCiphertext: string;
};

export type ByosDeliverReply =
    | { kind: 'accepted'; duplicate?: true }
    | { kind: 'refused'; reason: string }
    | { kind: 'unknown'; reason: string };

export type ByosOfflineAuthorization =
    | { kind: 'authorized' }
    | { kind: 'refused'; reason: string }
    | { kind: 'unknown'; reason: string };

export type ByosOfflineReceiveDeps = {
    /** This machine's own id. A request naming another machine is not ours. */
    machineId: string;
    /** Session this daemon is holding, or `null`. `undefined` never happens. */
    findHostedSession: (sessionId: string) => ByosHostedSession | null;
    /** Asks the parent, over the configured origin, whether this may proceed. */
    authorize: (request: ByosDeliverRequest) => Promise<ByosOfflineAuthorization>;
    /**
     * The side effect: hand the decrypted body to the session.
     *
     * `ok` must mean the session **took** it — an acknowledgement from the
     * other side, not that a local callback returned. A lost acknowledgement is
     * `retryable`, which this receiver reports as `unknown`, because the work
     * may already be running.
     */
    submitToSession: (input: {
        sessionId: string;
        session: ByosHostedSession;
        body: unknown;
    }) => Promise<{ ok: true } | { ok: false; reason: string }>;
    store: ReturnType<typeof createByosOfflineReceiptStore>;
};

/**
 * The two handlers as the machine RPC surface sees them.
 *
 * Params arrive decrypted and **unvalidated** — the caller is whoever holds the
 * machine key, so every field is checked here before it is used.
 */
export type ByosOfflineRpcHandlers = {
    confirmSessionHost: (params: unknown) => Promise<ByosConfirmHostReply>;
    deliver: (params: unknown) => Promise<ByosDeliverReply>;
};

const TEXT = /^[A-Za-z0-9._:-]{1,200}$/;

function text(value: unknown): string | null {
    return typeof value === 'string' && TEXT.test(value) ? value : null;
}

/** The delivery request, or `null`. Nothing partial is repaired. */
export function parseByosDeliverRequest(params: unknown): ByosDeliverRequest | null {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
    const raw = params as Record<string, unknown>;
    const actorUserId = text(raw.actorUserId);
    const requestKey = text(raw.requestKey);
    const claimId = text(raw.claimId);
    const projectId = text(raw.projectId);
    const sessionId = text(raw.sessionId);
    const machineId = text(raw.machineId);
    const digest = typeof raw.ciphertextDigest === 'string'
        && /^[0-9a-f]{64}$/.test(raw.ciphertextDigest)
        ? raw.ciphertextDigest
        : null;
    const payloadCiphertext = typeof raw.payloadCiphertext === 'string'
        && raw.payloadCiphertext !== ''
        ? raw.payloadCiphertext
        : null;
    if (!actorUserId || !requestKey || !claimId || !projectId) return null;
    if (!sessionId || !machineId || !digest || !payloadCiphertext) return null;
    const bindingVersion = raw.bindingVersion ?? null;
    if (bindingVersion !== null && !Number.isSafeInteger(bindingVersion)) return null;
    return {
        actorUserId, requestKey, claimId, projectId, sessionId, machineId,
        bindingVersion: bindingVersion as number | null,
        ciphertextDigest: digest,
        payloadCiphertext,
    };
}

/** The host question, or `null`. */
export function parseByosConfirmHostRequest(params: unknown): ByosConfirmHostRequest | null {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
    const raw = params as Record<string, unknown>;
    const machineId = text(raw.machineId);
    const sessionId = text(raw.sessionId);
    const actorUserId = text(raw.actorUserId);
    if (!machineId || !sessionId || !actorUserId) return null;
    return { machineId, sessionId, actorUserId };
}

/**
 * The registered handlers.
 *
 * A request that does not parse is `refused`/`not-hosting`, not `unknown`: it
 * never described a delivery, so nothing about it is in doubt.
 */
export function createByosOfflineRpcHandlers(
    deps: ByosOfflineReceiveDeps,
): ByosOfflineRpcHandlers {
    return {
        async confirmSessionHost(params) {
            const request = parseByosConfirmHostRequest(params);
            if (!request) return { kind: 'not-hosting', reason: 'malformed-request' };
            return confirmByosOfflineSessionHost(request, deps);
        },
        async deliver(params) {
            const request = parseByosDeliverRequest(params);
            if (!request) return { kind: 'refused', reason: 'malformed-request' };
            return receiveByosOfflineDelivery(request, deps);
        },
    };
}

/** The digest the parent computes: sha256 of the base64 **as received**. */
export function byosOfflineCiphertextDigest(payloadCiphertext: string): string {
    return createHash('sha256').update(payloadCiphertext).digest('hex');
}

export function confirmByosOfflineSessionHost(
    request: ByosConfirmHostRequest,
    deps: Pick<ByosOfflineReceiveDeps, 'machineId' | 'findHostedSession'>,
): ByosConfirmHostReply {
    if (request.machineId !== deps.machineId) {
        return { kind: 'not-hosting', reason: 'another-machine' };
    }
    let hosted: ByosHostedSession | null;
    try {
        hosted = deps.findHostedSession(request.sessionId);
    } catch {
        // 우리가 들고 있는지 **모르는** 것이지, 안 들고 있는 것이 아니다.
        return { kind: 'unknown', reason: 'session-lookup-failed' };
    }
    return hosted ? { kind: 'hosting' } : { kind: 'not-hosting', reason: 'session-not-here' };
}

export async function receiveByosOfflineDelivery(
    request: ByosDeliverRequest,
    deps: ByosOfflineReceiveDeps,
): Promise<ByosDeliverReply> {
    if (request.machineId !== deps.machineId) {
        return { kind: 'refused', reason: 'another-machine' };
    }
    /*
     * 전선의 digest 를 믿지 않고 **받은 바이트**로 다시 계산한다. 이것이 부모의
     * 행과 대조되는 값이므로, 여기서 남의 값을 받아 쓰면 대조가 무의미해진다.
     */
    const digest = byosOfflineCiphertextDigest(request.payloadCiphertext);
    if (digest !== request.ciphertextDigest) {
        return { kind: 'refused', reason: 'ciphertext-digest-mismatch' };
    }

    let hosted: ByosHostedSession | null;
    try {
        hosted = deps.findHostedSession(request.sessionId);
    } catch {
        return { kind: 'unknown', reason: 'session-lookup-failed' };
    }
    if (!hosted) return { kind: 'refused', reason: 'session-not-here' };

    /*
     * **봉투를 여는 것은 기밀성 검사이지 신원 검사가 아니다.** 열린다는 것은 이
     * 세션의 키로 봉인됐다는 뜻일 뿐이고, 누가 봉인했는지는 말하지 않는다.
     * 그래서 이것만으로는 아무것도 실행하지 않는다.
     */
    let body: unknown;
    try {
        body = decrypt(
            hosted.encryptionKey,
            hosted.encryptionVariant,
            decodeBase64(request.payloadCiphertext),
        );
    } catch {
        return { kind: 'refused', reason: 'envelope-unopenable' };
    }
    if (body === null || body === undefined) {
        return { kind: 'refused', reason: 'envelope-unopenable' };
    }

    /*
     * **부모가 권위다.** 여기까지 통과한 것은 "이 세션의 키를 가진 누군가가
     * 보냈다" 뿐이며, 그 사람이 누구인지, 그리고 지금도 그럴 자격이 있는지는
     * 부모만 안다. 확인하지 못하면 붙들고, 지어내지 않는다.
     */
    let authorized: ByosOfflineAuthorization;
    try {
        authorized = await deps.authorize(request);
    } catch {
        return { kind: 'unknown', reason: 'authorization-unreachable' };
    }
    if (authorized.kind === 'refused') return { kind: 'refused', reason: authorized.reason };
    if (authorized.kind !== 'authorized') {
        return { kind: 'unknown', reason: authorized.reason };
    }

    /*
     * **인가 왕복 뒤에 수신자를 다시 본다.** 처음 읽은 것은 그 사이에 끝났거나
     * 다시 태어났을 수 있고, 그때 캐시된 것으로 보내면 이미 없는(또는 다른)
     * 수신자에게 보낸 것을 전달로 보고하게 된다. 호스트 확인(preflight)은
     * "그때 여기 있었다" 이지 최종 수신자를 정하지 않는다.
     *
     * **기록보다 먼저** 본다. 기록을 남긴 뒤 여기서 거절하면 그 `pending` 이
     * 남아 다음 재시도마다 `in-progress` 가 된다 — 아무 일도 일어나지 않았는데
     * 영원히 사람을 기다리게 된다. 이 검사와 제출 사이에는 await 가 없다.
     */
    let current: ByosHostedSession | null;
    try {
        current = deps.findHostedSession(request.sessionId);
    } catch {
        return { kind: 'unknown', reason: 'session-lookup-failed' };
    }
    if (!current) return { kind: 'refused', reason: 'session-not-here' };
    if (current.incarnation !== hosted.incarnation) {
        return { kind: 'refused', reason: 'session-replaced' };
    }

    const intent: ByosOfflineIntent = {
        actorUserId: request.actorUserId,
        requestKey: request.requestKey,
        projectId: request.projectId,
        sessionId: request.sessionId,
        machineId: request.machineId,
        bindingVersion: request.bindingVersion,
        ciphertextDigest: digest,
    };

    // **부수효과 전에** 기록한다. 이후의 어떤 죽음도 "안 일어났다" 로 읽히지 않는다.
    const begun = deps.store.begin(intent);
    if (begun.kind === 'conflict') return { kind: 'refused', reason: begun.reason };
    if (begun.kind === 'unknown') return { kind: 'unknown', reason: begun.detail };
    /*
     * 이미 정산된 것만 `duplicate` 다. 미정산 기록은 실행 여부를 모르므로
     * `accepted` 로 답하면 부모가 실행되지 않았을 수도 있는 요청을 닫는다.
     */
    if (begun.kind === 'settled') return { kind: 'accepted', duplicate: true };
    if (begun.kind === 'in-progress') return { kind: 'unknown', reason: 'delivery-in-progress' };

    let submitted: Awaited<ReturnType<ByosOfflineReceiveDeps['submitToSession']>>;
    try {
        submitted = await deps.submitToSession({
            sessionId: request.sessionId, session: current, body,
        });
    } catch {
        // 던진 예외는 도착 여부의 증거가 아니다. 기록은 pending 으로 남는다.
        return { kind: 'unknown', reason: 'submit-failed' };
    }
    /*
     * 제출이 시작된 뒤의 실패는 **아무 일도 없었다는 증거가 아니다** — 보고는
     * 증명이 아니고, 그 사이에 세션이 이미 반영했을 수 있다. 그래서 전부 보류다.
     *
     * "무효과" 를 어댑터가 말하게 하는 길도 생각했지만 두지 않았다. 지금 어댑터
     * 는 그것을 증명할 수 없고, 설령 플래그가 있어도 기록은 남으므로 그 다음
     * 재시도는 어차피 `in-progress` 가 된다 — 거절로 답해 봐야 부모만 헷갈린다.
     * 되돌리기(durable abort)까지 갖춘 어댑터가 생기면 그때 함께 만든다.
     *
     * 기록은 지우지 않는다: 지우면 다음 재시도가 처음처럼 굴어 같은 작업이 두 번
     * 실행된다.
     */
    if (!submitted.ok) return { kind: 'unknown', reason: submitted.reason };

    const settled = deps.store.settle(intent);
    if (settled.kind !== 'settled') {
        /*
         * 일어난 일은 되돌릴 수 없는데 그 사실을 적지 못했다. `accepted` 로
         * 답하면 증거 없이 닫는 것이고, `refused` 로 답하면 같은 작업이 다시
         * 실행된다. 사람이 정하게 남긴다.
         */
        return { kind: 'unknown', reason: 'receipt-unwritable' };
    }
    return { kind: 'accepted' };
}
