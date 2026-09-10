/**
 * specs/runtime-isolation-hardening (H3) — policy for binding a preview token
 * to one project's actually-running dev server.
 *
 * Three rules this module exists to keep honest:
 *
 * 1. **Only the trusted studio path can bind.** A happy bearer proves which
 *    *account* owns the machine, not who is asking: on a company-owned
 *    machine every member holds one, and `/v1/preview-token` only ever
 *    checked `machine.accountId`. A `studioUserId` arriving on that path is
 *    a caller assertion, so binding to it would let any member mint a token
 *    in anyone else's name. The bearer path therefore mints unbound or not
 *    at all, and the requirement is a server rollout policy, never a client
 *    flag.
 * 2. **An old daemon must fail loudly, not quietly.** It has no handler for
 *    the lease event, so its "answer" is silence or an unrecognised shape.
 *    That is reported as `RUNTIME_BINDING_UNSUPPORTED` with update guidance —
 *    never as permission to mint an unbound token.
 * 3. **Enforcement is confirmed per request, not assumed.** A daemon that
 *    checked the lease echoes `bindingEnforced: true`. A daemon that was
 *    downgraded after the token was minted returns an ordinary success
 *    envelope without it, and the relay treats that as a failure.
 */

import type { PreviewTokenBinding } from '@/modules/preview/previewToken';

export const LEASE_UNSUPPORTED_CODE = 'RUNTIME_BINDING_UNSUPPORTED';

const UNSUPPORTED_MESSAGE =
    '이 머신의 daemon 이 프리뷰 런타임 결속을 지원하지 않습니다. happy-cli 를 업데이트한 뒤 다시 시도하세요.';

export interface PreviewBindingPolicy {
    mode: 'off' | 'required';
    /** Machines the operator deliberately keeps on unbound tokens. */
    legacyMachineIds: ReadonlySet<string>;
}

export function resolvePreviewBindingPolicy(env: Record<string, string | undefined>): PreviewBindingPolicy {
    const raw = (env.PREVIEW_RUNTIME_BINDING_POLICY ?? '').trim().toLowerCase();
    const legacyMachineIds = new Set(
        (env.PREVIEW_BINDING_LEGACY_MACHINE_IDS ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
    );
    return { mode: raw === 'required' ? 'required' : 'off', legacyMachineIds };
}

export type MintBindingDecision = { kind: 'bind-required' } | { kind: 'bind-optional' };

/** Trusted (studio) mint: may the caller still ask for an unbound token? */
export function decideMintBinding(policy: PreviewBindingPolicy, machineId: string): MintBindingDecision {
    if (policy.mode !== 'required') return { kind: 'bind-optional' };
    if (policy.legacyMachineIds.has(machineId)) return { kind: 'bind-optional' };
    return { kind: 'bind-required' };
}

/**
 * specs/runtime-isolation-hardening (H3, P4) — what the caller says about the
 * token being replaced.
 *
 * `invalid` is never folded into `absent`. Ignoring an unreadable previous
 * token would be the downgrade path itself: drop the field, get a weaker
 * token.
 */
export type PreviousTokenCheck =
    | { kind: 'absent' }
    | { kind: 'invalid' }
    | { kind: 'token'; claims: { machineId: string; port: number; bind?: PreviewTokenBinding } };

export type TrustedMintPlan =
    | { kind: 'bind'; forced: boolean }
    | { kind: 'unbound'; reason: 'legacy-machine' | 'policy-off' }
    | { kind: 'reject'; status: 400 | 403; code: string; message: string };

/**
 * The one place that decides whether a trusted (studio) mint binds.
 *
 * Order matters and is the whole point:
 *
 * 1. **A bound recovery stays bound.** The token being replaced already had
 *    ACL and runtime checks; re-minting it unbound because a dev server
 *    restarted would silently drop them. This outranks both the policy and
 *    the operator's legacy exception.
 * 2. **An explicit legacy machine mints unbound *before* any binding is
 *    attempted.** The studio always sends the binding fields, so without this
 *    the operator's own per-machine exception could never be honoured — the
 *    machine would fail at the lease instead. Explicit ids only; nothing is
 *    inferred from a port or a name.
 * 3. Otherwise the policy decides.
 */
export function planTrustedMint(input: {
    policy: PreviewBindingPolicy;
    machineId: string;
    port: number;
    projectId?: string;
    studioUserId?: string;
    previous: PreviousTokenCheck;
}): TrustedMintPlan {
    const { previous } = input;
    if (previous.kind === 'invalid') {
        return {
            kind: 'reject',
            status: 400,
            code: 'INVALID_PREVIOUS_TOKEN',
            message: '재발급 요청의 이전 토큰을 확인할 수 없습니다.',
        };
    }
    if (previous.kind === 'token') {
        if (previous.claims.machineId !== input.machineId || previous.claims.port !== input.port) {
            return {
                kind: 'reject',
                status: 400,
                code: 'PREVIOUS_TOKEN_MISMATCH',
                message: '이전 토큰이 이 머신/포트의 것이 아닙니다.',
            };
        }
        const bind = previous.claims.bind;
        if (bind) {
            if (bind.projectId !== input.projectId || bind.studioUserId !== input.studioUserId) {
                return {
                    kind: 'reject',
                    status: 403,
                    code: 'PREVIOUS_TOKEN_MISMATCH',
                    message: '이전 토큰의 프로젝트/사용자와 일치하지 않습니다.',
                };
            }
            return { kind: 'bind', forced: true };
        }
    }

    if (input.policy.legacyMachineIds.has(input.machineId)) {
        return { kind: 'unbound', reason: 'legacy-machine' };
    }
    if (input.projectId && input.studioUserId) {
        return { kind: 'bind', forced: false };
    }
    if (input.policy.mode === 'required') {
        return {
            kind: 'reject',
            status: 400,
            code: 'BINDING_REQUIRED',
            message: 'projectId and studioUserId are required for preview tokens on this machine',
        };
    }
    return { kind: 'unbound', reason: 'policy-off' };
}

export const BEARER_BINDING_UNSUPPORTED_CODE = 'BEARER_BINDING_UNSUPPORTED';

export type BearerMintDecision =
    | { kind: 'unbound' }
    | { kind: 'reject'; status: 403; code: string; message: string };

/**
 * Bearer mint: the token is always unbound, so the only question is whether
 * an unbound token is still acceptable on this machine. Under the required
 * policy it is not, and this path cannot produce a bound one — the honest
 * answer is to send the caller to the trusted studio path rather than to
 * quietly hand out the weaker token the policy just outlawed.
 */
export function decideBearerMint(policy: PreviewBindingPolicy, machineId: string): BearerMintDecision {
    if (policy.mode !== 'required') return { kind: 'unbound' };
    if (policy.legacyMachineIds.has(machineId)) return { kind: 'unbound' };
    return {
        kind: 'reject',
        status: 403,
        code: BEARER_BINDING_UNSUPPORTED_CODE,
        message: '이 머신의 프리뷰 토큰은 aplus-dev-studio 를 통해서만 발급할 수 있습니다.',
    };
}

export type RelayBindingDecision =
    | { kind: 'enforce'; bind: PreviewTokenBinding }
    | { kind: 'allow-unbound'; reason: 'policy-off' | 'legacy-machine' }
    | { kind: 'reject'; status: number; code: string; message: string };

export function decideRelayBinding(
    policy: PreviewBindingPolicy,
    machineId: string,
    claims: { bind?: PreviewTokenBinding },
): RelayBindingDecision {
    // A minted binding is always enforced. The allowlist grants permission to
    // mint unbound, not permission to ignore a binding that already exists.
    if (claims.bind) return { kind: 'enforce', bind: claims.bind };
    if (policy.mode !== 'required') return { kind: 'allow-unbound', reason: 'policy-off' };
    if (policy.legacyMachineIds.has(machineId)) return { kind: 'allow-unbound', reason: 'legacy-machine' };
    return {
        kind: 'reject',
        status: 401,
        code: 'binding-missing',
        message: 'Preview token is not bound to a project runtime',
    };
}

export type LeaseAck =
    | { type: 'success'; leaseId: string; evidenceKind: string }
    | { type: 'error'; code: string; message: string };

export function interpretLeaseAck(raw: unknown): LeaseAck {
    if (raw && typeof raw === 'object') {
        const candidate = raw as Record<string, unknown>;
        if (
            candidate.type === 'success' &&
            typeof candidate.leaseId === 'string' && candidate.leaseId.length > 0 &&
            typeof candidate.evidenceKind === 'string'
        ) {
            return { type: 'success', leaseId: candidate.leaseId, evidenceKind: candidate.evidenceKind };
        }
        if (
            candidate.type === 'error' &&
            typeof candidate.code === 'string' && candidate.code.length > 0
        ) {
            return {
                type: 'error',
                code: candidate.code,
                message: typeof candidate.message === 'string' ? candidate.message : '',
            };
        }
    }
    return { type: 'error', code: LEASE_UNSUPPORTED_CODE, message: UNSUPPORTED_MESSAGE };
}

/**
 * The daemon's probe queue is saturated, so it did not look. Backpressure —
 * not an authorization answer, and not evidence that nothing is there. It is
 * the one daemon refusal that says "ask again in a moment", so it answers 503
 * everywhere rather than 403 (which re-minting could never clear) or 502
 * (which reads as "the dev server is unreachable" to checkPortReachable).
 */
export const EVIDENCE_BUSY_CODE = 'EVIDENCE_BUSY';

export function isRuntimeEvidenceBusy(code: string | null | undefined): boolean {
    return code === EVIDENCE_BUSY_CODE;
}

/** Narrow union so route reply schemas can name every status this can emit. */
export type LeaseFailureStatus = 400 | 403 | 404 | 409 | 502 | 503;

export interface LeaseFailureResponse {
    status: LeaseFailureStatus;
    body: { error: string; code: string };
}

export function describeLeaseFailure(ack: { type: 'error'; code: string; message: string }): LeaseFailureResponse {
    // Retryable: the machine is busy, so nothing about this project's access
    // or runtime was decided. Never a weaker token — load must not become the
    // way to lose the binding.
    if (isRuntimeEvidenceBusy(ack.code)) {
        return {
            status: 503,
            body: {
                error: ack.message || '머신이 바빠 런타임을 확인하지 못했습니다. 잠시 후 다시 시도하세요.',
                code: EVIDENCE_BUSY_CODE,
            },
        };
    }
    if (ack.code === LEASE_UNSUPPORTED_CODE) {
        return { status: 409, body: { error: UNSUPPORTED_MESSAGE, code: LEASE_UNSUPPORTED_CODE } };
    }
    // The daemon proved the runtime on that port is not this project's — a
    // port registered elsewhere, a container labelled for another project, or
    // a process outside the project's workspace. All authorization answers.
    if (
        ack.code === 'PORT_PROJECT_MISMATCH' ||
        ack.code === 'PROJECT_OWNERSHIP_MISMATCH' ||
        ack.code === 'WORKSPACE_UNVERIFIED'
    ) {
        return {
            status: 403,
            body: { error: '요청한 포트가 이 프로젝트의 실행 중인 런타임이 아닙니다.', code: ack.code },
        };
    }
    // NO_LISTENER / EVIDENCE_UNAVAILABLE — the runtime cannot be proven right
    // now. 409 keeps it distinct from an authorization failure so the caller
    // can retry once the dev server is up.
    if (ack.code === 'NO_LISTENER' || ack.code === 'EVIDENCE_UNAVAILABLE') {
        return {
            status: 409,
            body: {
                error: ack.message || '포트에서 실행 중인 런타임을 확인할 수 없습니다.',
                code: ack.code,
            },
        };
    }
    return { status: 502, body: { error: ack.message || 'Runtime lease failed', code: ack.code } };
}

/**
 * A daemon refusal that says "this token is out of date", not "you may not
 * have this". A container restart legitimately changes the runtime, so the
 * lease the token carries stops matching and the caller has to mint a new
 * one — answering 403 there would strand a user who still has full access
 * behind a page that can never recover. Ownership failures are the opposite:
 * re-minting produces the same refusal, so they stay a hard 403.
 */
export function isStaleRuntimeBinding(code: string): boolean {
    return code === 'LEASE_MISMATCH';
}

export function isBindingEnforcementEchoed(response: { bindingEnforced?: unknown } | undefined): boolean {
    return response?.bindingEnforced === true;
}
