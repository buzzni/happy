/**
 * The grants a managed child acts under, and the check every action makes.
 *
 * A scoped token carries a claim; this row decides whether the claim is still
 * true. The two are separate because a token cannot be recalled once handed
 * out, so the authority to act has to live somewhere the control plane can
 * withdraw it.
 *
 * Three rules this module owns — not the routes that call it:
 *
 *  - **The caller never supplies scope this server could look up, and never
 *    collects more than it asked for.** A mint presents the complete scope it
 *    signed and every field is compared exactly against the projection.
 *    Filling a missing field from the current row is what would let a delayed
 *    assertion, signed against epoch 3, be promoted to whatever the workspace
 *    happens to be now — and the same applies to time: a replayed mint is
 *    answered with the expiry it signed, not the one a later renewal wrote.
 *  - **A family is derived, not named.** It is the canonical digest of the
 *    scope's identity, so the same run, attempt and session always resolve to
 *    the same family. A caller that could choose the string could route around
 *    a revoke by picking a new one.
 *  - **Freshness is re-derived, never remembered.** Every action re-reads the
 *    authority projection and the session's owner in one consistent read. A
 *    grant minted against epoch 3 stops working when the workspace reaches
 *    epoch 4, without anyone walking the grant table to find it. A renewal
 *    extends such a grant only while it is still current; a stale one has to be
 *    re-minted rather than promoted.
 */

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import {
    SESSION_SCOPED_PURPOSES,
    type SessionScopedPurpose,
} from '@/app/auth/sessionScopedToken';
import { canonicalDigest } from '@/app/managed/canonicalDigest';
import type { SessionScopedClaims } from '@/app/auth/sessionScopedToken';

const UNIQUE_VIOLATION = 'P2002';

/**
 * Raised when a compare-and-set matched nothing.
 *
 * Not a failure to report: the row moved, and the answer is whatever it moved
 * to. Reading that inside the same transaction would only re-read the snapshot
 * this one started with, so the attempt is repeated in a fresh one.
 */
class ConcurrentGrantChange extends Error {}
const FOREIGN_KEY_VIOLATION = 'P2003';

/**
 * The complete scope a control-plane assertion signs.
 *
 * Every field is compared; none is defaulted. A shape that let a field be
 * omitted would make "the control plane did not say" indistinguishable from
 * "the control plane agreed with the current row".
 */
export type ManagedScope = {
    tenantId: string;
    projectId: string;
    workspaceId: string;
    runtimeId: string;
    epoch: number;
    runId: string;
    attemptId: string;
    sessionId: string;
    accountId: string;
    workspaceAuthorityVersion: number;
    runAuthorityVersion: number;
};

/**
 * The family a scope belongs to.
 *
 * Identity only: the versions and epoch are deliberately excluded, because a
 * grant that goes stale is caught by the freshness check rather than by landing
 * in a different family. Including them would give a caller a new family for
 * every version bump — the revoke bypass this derivation exists to close.
 */
export function deriveGrantFamily(
    scope: ManagedScope,
    /**
     * Part of the family, so two purposes for one scope are two grants.
     *
     * Without this a read grant and the runner's grant would be the same
     * family: minting one would either be refused as "family-exists" or replace
     * the other, which is the run losing its own credential because somebody
     * opened a transcript.
     *
     * `runner` contributes nothing to the digest, deliberately: every grant
     * that exists today is a runner grant, and changing their family value
     * would orphan every stored row from the derivation that finds it.
     */
    purpose: SessionScopedPurpose = 'runner',
): string {
    if (purpose !== 'runner') {
        return canonicalDigest({
            tenantId: scope.tenantId,
            projectId: scope.projectId,
            workspaceId: scope.workspaceId,
            runId: scope.runId,
            attemptId: scope.attemptId,
            sessionId: scope.sessionId,
            accountId: scope.accountId,
            purpose,
        });
    }
    return canonicalDigest({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        workspaceId: scope.workspaceId,
        runId: scope.runId,
        attemptId: scope.attemptId,
        sessionId: scope.sessionId,
        accountId: scope.accountId,
    });
}

export type ScopeMismatch =
    | 'run-unknown'
    | 'run-cancelled'
    | 'authority-stale'
    | 'account-mismatch'
    | 'attempt-mismatch'
    | 'binding-mismatch';

/**
 * Postgres `INTEGER`. The sequence is compared and incremented, never wrapped:
 * a counter that rolled over would make an old signature match again.
 */
const MAX_RENEWAL_SEQ = 2_147_483_647;

export type GrantIssueFailure =
    | 'grant-id-reused'
    | 'sequence-exhausted'
    | ScopeMismatch
    | 'session-unknown'
    | 'session-owner-changed'
    | 'family-revoked'
    | 'family-exists'
    | 'request-conflict'
    | 'already-expired';

export type GrantRenewFailure =
    | 'grant-mismatch'
    | 'sequence-exhausted'
    | ScopeMismatch
    | 'grant-unknown'
    | 'revoked'
    | 'expired'
    | 'renewal-conflict'
    | 'not-extending';

export type GrantCheckFailure =
    | ScopeMismatch
    | 'grant-unknown'
    | 'revoked'
    | 'expired'
    | 'session-unknown'
    | 'session-owner-changed'
    | 'claims-mismatch';

export type RevokeFailure = 'run-unknown' | 'binding-mismatch';

export type GrantResolveFailure =
    | ScopeMismatch
    | 'grant-unknown'
    | 'revoked'
    | 'expired'
    | 'session-unknown'
    | 'session-owner-changed'
    | 'already-expired'
    /** The stored row was minted for an older generation of this scope. */
    | 'grant-stale';

export type LiveGrant = {
    grantId: string;
    family: string;
    sessionId: string;
    accountId: string;
    workspaceId: string;
    runId: string;
    attemptId: string;
    epoch: number;
    workspaceAuthorityVersion: number;
    runAuthorityVersion: number;
    renewalSeq: number;
    expiresAt: number;
    purpose: SessionScopedPurpose;
};

export type GrantResult<F> =
    | { ok: true; grant: LiveGrant; idempotent: boolean }
    | { ok: false; reason: F };

type GrantRow = {
    grantId: string; family: string; sessionId: string; accountId: string;
    workspaceId: string; runId: string; attemptId: string; epoch: number;
    workspaceAuthorityVersion: number; runAuthorityVersion: number;
    renewalSeq: number; expiresAt: bigint;
    /** Stored as text; classified on the way out, never trusted as typed. */
    purpose: string;
};

type AuthorityRow = {
    workspaceId: string;
    accountId: string;
    currentAttemptId: string;
    cancelledAt: bigint | null;
    version: number;
    workspace: {
        tenantId: string; projectId: string; runtimeId: string;
        epoch: number; version: number;
    };
};

function toLiveGrant(row: GrantRow): LiveGrant {
    return {
        grantId: row.grantId,
        family: row.family,
        sessionId: row.sessionId,
        accountId: row.accountId,
        workspaceId: row.workspaceId,
        runId: row.runId,
        attemptId: row.attemptId,
        epoch: row.epoch,
        workspaceAuthorityVersion: row.workspaceAuthorityVersion,
        runAuthorityVersion: row.runAuthorityVersion,
        renewalSeq: row.renewalSeq,
        expiresAt: Number(row.expiresAt),
        // A stored value outside the three the server knows is not classified,
        // and an unclassified grant is not one this server will act on. It is
        // never folded into `runner`, which would be reading "unknown" as
        // "execution".
        purpose: readStoredPurpose(row.purpose),
    };
}

function readStoredPurpose(value: unknown): SessionScopedPurpose {
    if (typeof value !== 'string' || !(SESSION_SCOPED_PURPOSES as readonly string[]).includes(value)) {
        throw new Error('managed session grant carries an unknown purpose');
    }
    return value as SessionScopedPurpose;
}

const AUTHORITY_INCLUDE = {
    workspace: {
        select: { tenantId: true, projectId: true, runtimeId: true, epoch: true, version: true },
    },
} as const;

/**
 * Compares a signed scope against the projection, field by field.
 *
 * Nothing is filled in from the row. Every value the assertion signed must
 * still be the current one, so an assertion that sat in a queue while the
 * workspace moved on is refused rather than re-pointed at the new generation.
 */
function compareScope(authority: AuthorityRow | null, scope: ManagedScope): ScopeMismatch | null {
    if (!authority) return 'run-unknown';
    if (authority.cancelledAt !== null) return 'run-cancelled';
    if (authority.workspaceId !== scope.workspaceId) return 'binding-mismatch';
    if (authority.workspace.tenantId !== scope.tenantId
        || authority.workspace.projectId !== scope.projectId) {
        return 'binding-mismatch';
    }
    if (authority.accountId !== scope.accountId) return 'account-mismatch';
    if (authority.currentAttemptId !== scope.attemptId) return 'attempt-mismatch';
    if (authority.workspace.runtimeId !== scope.runtimeId
        || authority.workspace.epoch !== scope.epoch
        || authority.workspace.version !== scope.workspaceAuthorityVersion
        || authority.version !== scope.runAuthorityVersion) {
        return 'authority-stale';
    }
    return null;
}

/**
 * Compares the **stored row** against a scope, field by field.
 *
 * `compareScope` only says the caller agrees with the current projection; it
 * says nothing about the row that was minted earlier. The family deliberately
 * excludes epoch and the authority versions, so an old grant is still found by
 * a scope that has since moved on — and answering with it would hand out a
 * token whose claims describe a generation the row was never issued for. The
 * family is re-derived here too: a row whose scope hashes elsewhere is not this
 * scope's grant even when every field above matches.
 */
function compareStoredGrant(
    grant: GrantRow,
    scope: ManagedScope,
    /**
     * What the caller says this grant is for.
     *
     * Compared as its own axis **and** folded into the family below, because
     * the two answer different questions: the family says which row to look
     * for, and this says the row we found is the one the caller means. Left
     * fixed at `runner`, a read grant was never found by its own purpose — the
     * lookup returned the runner row, and every later check compared against
     * that row's authority.
     */
    purpose: SessionScopedPurpose,
): 'mismatch' | null {
    if (readStoredPurpose(grant.purpose) !== purpose) return 'mismatch';
    if (grant.sessionId !== scope.sessionId
        || grant.accountId !== scope.accountId
        || grant.workspaceId !== scope.workspaceId
        || grant.runId !== scope.runId
        || grant.attemptId !== scope.attemptId
        || grant.epoch !== scope.epoch
        || grant.workspaceAuthorityVersion !== scope.workspaceAuthorityVersion
        || grant.runAuthorityVersion !== scope.runAuthorityVersion) {
        return 'mismatch';
    }
    if (grant.family !== deriveGrantFamily(scope, purpose)) return 'mismatch';
    return null;
}

export type IssueGrantInput = {
    scope: ManagedScope;
    grantId: string;
    expiresAt: number;
    requestId: string;
    now: number;
    /** Defaults to `runner`: the behaviour every existing caller relies on. */
    purpose?: SessionScopedPurpose;
};

/**
 * Issues a first grant or replaces an expired, non-revoked family grant.
 *
 * Order matters and is the point of the function: the revoke state, the
 * authority comparison and the expiry are all decided *before* an exact retry
 * can return a stored grant. A retry of a mint whose family was revoked in
 * between must fail, or a withdrawn child is handed a working token by
 * repeating the request that created it.
 */
export async function issueSessionGrant(
    input: IssueGrantInput,
): Promise<GrantResult<GrantIssueFailure>> {
    // A constraint violation aborts the transaction that raised it, so the
    // losing writer cannot read the winner's row from inside it; the retry
    // happens out here in a fresh transaction.
    return retryOnUniqueRace(() => issueSessionGrantOnce(input));
}

async function issueSessionGrantOnce(
    input: IssueGrantInput,
): Promise<GrantResult<GrantIssueFailure>> {
    const purpose = input.purpose ?? 'runner';
    const family = deriveGrantFamily(input.scope, purpose);
    const digest = canonicalDigest({
        scope: input.scope,
        grantId: input.grantId,
        expiresAt: input.expiresAt,
        // Part of the body: a retry that asks for a different purpose under the
        // same request id is a different request, not the same one again.
        ...(purpose === 'runner' ? {} : { purpose }),
    });

    return inTx(async (tx) => {
        const authority = await tx.managedRunAuthority.findUnique({
            where: { runId: input.scope.runId },
            include: AUTHORITY_INCLUDE,
        });
        const mismatch = compareScope(authority as AuthorityRow | null, input.scope);
        if (mismatch) return { ok: false, reason: mismatch };

        // A grant for a session that does not exist, or that belongs to another
        // account, could never resolve: minting one only moves the failure to
        // the child. The routes check the bearer; this checks the session.
        const session = await tx.session.findUnique({
            where: { id: input.scope.sessionId },
            select: { accountId: true },
        });
        if (!session) return { ok: false, reason: 'session-unknown' };
        if (session.accountId !== input.scope.accountId) {
            return { ok: false, reason: 'session-owner-changed' };
        }

        const existingFamily = await tx.managedSessionGrant.findUnique({ where: { family } });
        // Checked before any retry can succeed: a revoked family is closed to
        // every request, including one that already produced a grant.
        if (existingFamily && (existingFamily.revokedAt !== null || existingFamily.tombstone)) {
            return { ok: false, reason: 'family-revoked' };
        }
        if (input.expiresAt <= input.now) return { ok: false, reason: 'already-expired' };

        const existingRequest = await tx.managedSessionGrant.findUnique({
            where: { requestId: input.requestId },
        });
        if (existingRequest) {
            if (existingRequest.bodyDigest !== digest || existingRequest.family !== family) {
                return { ok: false, reason: 'request-conflict' };
            }
            if (Number(existingRequest.expiresAt) <= input.now) {
                return { ok: false, reason: 'already-expired' };
            }
            // The row may have been extended by a renewal since. This request
            // only ever authorised its own expiry, so what it hands back is
            // capped at that — a replay of an old mint must not collect a
            // later renewal's lifetime. The row keeps the renewed value.
            return {
                ok: true,
                grant: {
                    ...toLiveGrant(existingRequest),
                    expiresAt: Math.min(Number(existingRequest.expiresAt), input.expiresAt),
                },
                idempotent: true,
            };
        }
        if (existingFamily) {
            // The *grant* expired, which is not the same as the run stopping.
            // Refusing forever would make a lapsed grant unrecoverable, and a
            // second row would leave two live grants for one child — so the row
            // is replaced in place, under the state it was read in. The scope
            // was compared against the current authority above; nothing new is
            // granted and no attempt is started by this.
            if (Number(existingFamily.expiresAt) > input.now) {
                return { ok: false, reason: 'family-exists' };
            }
            // The replacement must be a different grant. `expectedGrantId` is
            // what tells a renewal which grant it holds, so reusing the id it
            // is replacing would leave that check unable to tell them apart.
            if (input.grantId === existingFamily.grantId) {
                return { ok: false, reason: 'grant-id-reused' };
            }
            const nextSeq = existingFamily.renewalSeq + 1;
            if (nextSeq > MAX_RENEWAL_SEQ) return { ok: false, reason: 'sequence-exhausted' };
            const replaced = await tx.managedSessionGrant.updateMany({
                where: {
                    family,
                    // The exact row that was read. A renewal that extended it,
                    // or a revoke that closed it, between the read and here
                    // makes this match nothing.
                    grantId: existingFamily.grantId,
                    renewalSeq: existingFamily.renewalSeq,
                    expiresAt: existingFamily.expiresAt,
                    revokedAt: null,
                    tombstone: false,
                },
                data: {
                    grantId: input.grantId,
                    requestId: input.requestId,
                    attemptId: input.scope.attemptId,
                    epoch: input.scope.epoch,
                    workspaceAuthorityVersion: input.scope.workspaceAuthorityVersion,
                    runAuthorityVersion: input.scope.runAuthorityVersion,
                    // Advanced, never reset. The sequence belongs to the family
                    // rather than to one grant: resetting it let a signature for
                    // an earlier grant match a later one at the same number,
                    // which is the ABA `expectedGrantId` alone cannot close
                    // while ids may repeat across generations.
                    renewalSeq: nextSeq,
                    expiresAt: BigInt(input.expiresAt),
                    bodyDigest: digest,
                    updatedAt: BigInt(input.now),
                },
            });
            // Someone else moved the row first. Their result is the current
            // one, and it has to be read in a transaction that can see it.
            if (replaced.count !== 1) throw new ConcurrentGrantChange();
            const row = await tx.managedSessionGrant.findUniqueOrThrow({ where: { family } });
            return { ok: true, grant: toLiveGrant(row), idempotent: false };
        }

        const created = await tx.managedSessionGrant.create({
            data: {
                grantId: input.grantId,
                family,
                sessionId: input.scope.sessionId,
                accountId: input.scope.accountId,
                purpose,
                workspaceId: input.scope.workspaceId,
                runId: input.scope.runId,
                attemptId: input.scope.attemptId,
                epoch: input.scope.epoch,
                workspaceAuthorityVersion: input.scope.workspaceAuthorityVersion,
                runAuthorityVersion: input.scope.runAuthorityVersion,
                renewalSeq: 0,
                expiresAt: BigInt(input.expiresAt),
                requestId: input.requestId,
                bodyDigest: digest,
                createdAt: BigInt(input.now),
                updatedAt: BigInt(input.now),
            },
        });
        return { ok: true, grant: toLiveGrant(created), idempotent: false };
    });
}

/**
 * Extends a live grant in place under compare-and-set.
 *
 * A renewal is a fresh decision to keep a child alive, so it repeats every
 * check a mint makes — including the exact scope comparison — before the
 * sequence is considered. An idempotent answer is likewise only reachable once
 * those checks have passed.
 */
export async function renewSessionGrant(input: {
    scope: ManagedScope;
    /**
     * The grant the caller believes it holds.
     *
     * Names the current grant explicitly, alongside the monotonically
     * increasing family sequence. A renewal for a superseded grant must not
     * receive or extend its replacement, including an idempotent response.
     */
    expectedGrantId: string;
    expectedRenewalSeq: number;
    expiresAt: number;
    now: number;
    /**
     * Which grant for this scope. A renewal extends one grant; fixed at
     * `runner` it could only ever find the runner's, so a read grant could not
     * be renewed at all and a revoke aimed at the runner's row instead.
     */
    purpose?: SessionScopedPurpose;
}): Promise<GrantResult<GrantRenewFailure>> {
    const family = deriveGrantFamily(input.scope, input.purpose ?? 'runner');

    return inTx(async (tx) => {
        const authority = await tx.managedRunAuthority.findUnique({
            where: { runId: input.scope.runId },
            include: AUTHORITY_INCLUDE,
        });
        const mismatch = compareScope(authority as AuthorityRow | null, input.scope);
        if (mismatch) return { ok: false, reason: mismatch };

        const grant = await tx.managedSessionGrant.findUnique({ where: { family } });
        if (!grant || grant.tombstone) return { ok: false, reason: 'grant-unknown' };
        if (grant.revokedAt !== null) return { ok: false, reason: 'revoked' };
        if (grant.sessionId !== input.scope.sessionId
            || grant.accountId !== input.scope.accountId
            || grant.runId !== input.scope.runId
            || grant.attemptId !== input.scope.attemptId
            || grant.workspaceId !== input.scope.workspaceId) {
            return { ok: false, reason: 'binding-mismatch' };
        }
        // Compared before anything can succeed, the idempotent answer included:
        // a caller naming a grant this family no longer has is holding a
        // superseded one, and must be told so rather than handed the new one.
        if (grant.grantId !== input.expectedGrantId) {
            return { ok: false, reason: 'grant-mismatch' };
        }
        // The scope passing the projection comparison only says the *caller* is
        // current. A grant minted against an older generation is stale, and
        // renewing must not carry it forward: that would promote it to an
        // authority it was never issued under. It has to be re-minted.
        if (grant.epoch !== input.scope.epoch
            || grant.workspaceAuthorityVersion !== input.scope.workspaceAuthorityVersion
            || grant.runAuthorityVersion !== input.scope.runAuthorityVersion) {
            return { ok: false, reason: 'authority-stale' };
        }
        // A lapsed grant cannot authorize the child; expiry alone does not
        // prove process termination. Checked before the idempotent answer, so a repeat of
        // a renewal does not hand back a grant that has since lapsed.
        if (input.now >= Number(grant.expiresAt)) return { ok: false, reason: 'expired' };

        if (grant.renewalSeq === input.expectedRenewalSeq + 1
            && Number(grant.expiresAt) === input.expiresAt) {
            return { ok: true, grant: toLiveGrant(grant), idempotent: true };
        }
        if (grant.renewalSeq !== input.expectedRenewalSeq) {
            return { ok: false, reason: 'renewal-conflict' };
        }
        // A renewal that does not extend is a lost update wearing the right
        // sequence number.
        if (input.expiresAt <= Number(grant.expiresAt)) return { ok: false, reason: 'not-extending' };
        if (grant.renewalSeq + 1 > MAX_RENEWAL_SEQ) {
            return { ok: false, reason: 'sequence-exhausted' };
        }

        const updated = await tx.managedSessionGrant.updateMany({
            where: {
                family,
                // The id is part of the condition, not only of the read: a
                // remint between the read and here must make this match nothing.
                grantId: input.expectedGrantId,
                renewalSeq: input.expectedRenewalSeq,
                revokedAt: null,
            },
            data: {
                // The generation is deliberately untouched: a renewal extends
                // a grant, it does not re-issue it under a new authority.
                renewalSeq: { increment: 1 },
                expiresAt: BigInt(input.expiresAt),
                updatedAt: BigInt(input.now),
            },
        });
        if (updated.count !== 1) return { ok: false, reason: 'renewal-conflict' };

        return {
            ok: true,
            grant: {
                ...toLiveGrant(grant),
                renewalSeq: grant.renewalSeq + 1,
                expiresAt: input.expiresAt,
            },
            idempotent: false,
        };
    });
}

export type RevokeResult =
    | { ok: true; state: 'revoked' | 'tombstoned'; alreadyRevoked: boolean }
    | { ok: false; reason: RevokeFailure };

/**
 * Withdraws a family, whether or not a grant exists for it yet.
 *
 * With nothing issued this writes a tombstone carrying the same scope a mint
 * would have, so a revoke that arrives before the mint it cancels is recorded
 * rather than being a no-op the mint then lands behind. When a mint wins the
 * insert instead, the unique violation is retried out of transaction and the
 * second pass revokes the row that actually won — the outcome is a row with
 * `revokedAt` set either way, which is what the tests assert.
 */
export async function revokeSessionGrant(input: {
    scope: ManagedScope;
    reason: string;
    now: number;
    /** Which grant to withdraw. Omitted means `runner`. */
    purpose?: SessionScopedPurpose;
}): Promise<RevokeResult> {
    return retryOnUniqueRace(
        () => revokeSessionGrantOnce(input),
        // Nothing to hang a tombstone on: the run was never synced, so no grant
        // can exist for it either.
        () => ({ ok: false, reason: 'run-unknown' }),
    );
}

async function revokeSessionGrantOnce(input: {
    scope: ManagedScope;
    reason: string;
    now: number;
    purpose?: SessionScopedPurpose;
}): Promise<RevokeResult> {
    const family = deriveGrantFamily(input.scope, input.purpose ?? 'runner');

    return inTx(async (tx) => {
        const grant = await tx.managedSessionGrant.findUnique({ where: { family } });
        if (grant) {
            // The derivation already ties the family to this scope; this catches
            // a row that somehow carries a different binding rather than
            // withdrawing something other than what the caller signed.
            if (!grant.tombstone && (grant.runId !== input.scope.runId
                || grant.workspaceId !== input.scope.workspaceId
                || grant.accountId !== input.scope.accountId
                || grant.sessionId !== input.scope.sessionId)) {
                return { ok: false, reason: 'binding-mismatch' };
            }
            if (grant.revokedAt !== null) {
                // Terminal: the first reason stands, so an audit reads what
                // actually stopped the child.
                return {
                    ok: true,
                    state: grant.tombstone ? 'tombstoned' : 'revoked',
                    alreadyRevoked: true,
                };
            }
            await tx.managedSessionGrant.update({
                where: { family },
                data: {
                    revokedAt: BigInt(input.now),
                    revokedReason: input.reason,
                    updatedAt: BigInt(input.now),
                },
            });
            return { ok: true, state: 'revoked', alreadyRevoked: false };
        }

        await tx.managedSessionGrant.create({
            data: {
                grantId: `tombstone:${family}`,
                family,
                // The full signed scope, so the tombstone is the same shape as
                // the grant it prevents rather than a blank placeholder.
                sessionId: input.scope.sessionId,
                accountId: input.scope.accountId,
                workspaceId: input.scope.workspaceId,
                runId: input.scope.runId,
                attemptId: input.scope.attemptId,
                epoch: input.scope.epoch,
                workspaceAuthorityVersion: input.scope.workspaceAuthorityVersion,
                runAuthorityVersion: input.scope.runAuthorityVersion,
                renewalSeq: 0,
                expiresAt: BigInt(input.now),
                revokedAt: BigInt(input.now),
                revokedReason: input.reason,
                tombstone: true,
                requestId: `tombstone:${family}`,
                bodyDigest: '',
                createdAt: BigInt(input.now),
                updatedAt: BigInt(input.now),
            },
        });
        return { ok: true, state: 'tombstoned', alreadyRevoked: false };
    });
}

/**
 * The check every scoped action makes.
 *
 * It takes the whole verified claim set, not an id: the token's own scope is
 * what has to be compared, and a fresh read of the row cannot stand in for
 * that. Row, projection and the session's current owner are read in one
 * transaction so the answer is consistent rather than assembled from three
 * moments.
 *
 * Token lifetime, stated rather than implied: a renewal extends the grant and
 * issues a longer token; it does not invalidate the token already handed out,
 * which stays usable until its own `expiresAt`. Tokens carry no renewal
 * sequence, so this is the only coherent reading — and the one thing that stops
 * a token early is revocation, checked here on every action. A token may never
 * outlive the row that authorises it, so a claimed expiry beyond the grant's is
 * refused rather than truncated.
 *
 * Never cached. The point of a revocable grant is that it stops working between
 * one action and the next.
 */
export async function resolveLiveGrant(input: {
    claims: SessionScopedClaims;
    now: number;
}): Promise<{ ok: true; grant: LiveGrant } | { ok: false; reason: GrantCheckFailure }> {
    const { claims } = input;

    return inTx(async (tx) => {
        const grant = await tx.managedSessionGrant.findUnique({
            where: { grantId: claims.grantId },
        });
        if (!grant || grant.tombstone) return { ok: false, reason: 'grant-unknown' };
        if (grant.revokedAt !== null) return { ok: false, reason: 'revoked' };

        // The token may not outlive the row that authorises it, and neither may
        // be past its expiry.
        if (input.now >= Number(grant.expiresAt) || input.now >= claims.expiresAt) {
            return { ok: false, reason: 'expired' };
        }
        if (claims.expiresAt > Number(grant.expiresAt)) return { ok: false, reason: 'claims-mismatch' };

        const scope: ManagedScope = {
            tenantId: claims.tenantId,
            projectId: claims.projectId,
            workspaceId: claims.workspaceId,
            runtimeId: claims.runtimeId,
            epoch: claims.epoch,
            runId: claims.runId,
            attemptId: claims.attemptId,
            sessionId: claims.sessionId,
            accountId: claims.accountId,
            workspaceAuthorityVersion: claims.workspaceAuthorityVersion,
            runAuthorityVersion: claims.runAuthorityVersion,
        };
        // Same comparison the resolve path makes: the stored row has to be the
        // one this scope was issued for, not merely a member of its family.
        // Including the purpose: the row found by `grantId` must be the grant
        // this token says it is. Without it a read token carried a runner row's
        // authority, and a runner token would have been accepted against a read
        // row just as readily.
        if (compareStoredGrant(grant, scope, claims.purpose)) {
            return { ok: false, reason: 'claims-mismatch' };
        }

        const authority = await tx.managedRunAuthority.findUnique({
            where: { runId: claims.runId },
            include: AUTHORITY_INCLUDE,
        });
        const mismatch = compareScope(authority as AuthorityRow | null, scope);
        if (mismatch) return { ok: false, reason: mismatch };

        // The account a session belongs to can change under an account merge or
        // a transfer; a grant minted before that must not keep acting on it.
        const session = await tx.session.findUnique({
            where: { id: claims.sessionId },
            select: { accountId: true },
        });
        if (!session) return { ok: false, reason: 'session-unknown' };
        if (session.accountId !== claims.accountId) {
            return { ok: false, reason: 'session-owner-changed' };
        }

        return { ok: true, grant: toLiveGrant(grant) };
    });
}

/**
 * Re-runs an attempt once when a concurrent writer won a unique constraint.
 *
 * The violation aborts the transaction it happened in, so the recovery cannot
 * live next to the statement that raised it and an in-transaction catch would
 * be reporting success for work the database threw away. A foreign key
 * violation is not a race and is reported through `onMissingRun`.
 */
async function retryOnUniqueRace<T>(
    attempt: () => Promise<T>,
    onMissingRun?: () => T,
): Promise<T> {
    for (let remaining = 1; ; remaining--) {
        try {
            return await attempt();
        } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === FOREIGN_KEY_VIOLATION && onMissingRun) return onMissingRun();
            const raced = error instanceof ConcurrentGrantChange;
            if ((!raced && code !== UNIQUE_VIOLATION) || remaining === 0) {
                // A race that survives the retry is reported as the state that
                // beat it, not thrown at the caller.
                if (raced) return { ok: false, reason: 'family-exists' } as T;
                throw error;
            }
        }
    }
}

/** Read-only view for callers that already hold a verified grant id. */
export async function readGrantRow(grantId: string): Promise<LiveGrant | null> {
    const row = await db.managedSessionGrant.findUnique({ where: { grantId } });
    return row && !row.tombstone ? toLiveGrant(row) : null;
}

export type ResolveGrantInput = {
    scope: ManagedScope;
    /** The latest the caller signed for. The answer is never later than this. */
    requestedTokenExpiresAt: number;
    now: number;
    /**
     * Which grant for this scope. Omitted means `runner`, so every existing
     * caller resolves exactly what it resolved before.
     */
    purpose?: SessionScopedPurpose;
};

export type ResolvedGrant = {
    grant: LiveGrant;
    /** `min(grant expiry, signed request expiry)`. */
    tokenExpiresAt: number;
};

export type ResolveGrantResult =
    | { ok: true; resolved: ResolvedGrant }
    | { ok: false; reason: GrantResolveFailure };

/**
 * Reads the current grant for a scope so a caller that lost the mint response
 * can recover it — **without writing anything**.
 *
 * This is not an idempotent replay of the original mint. The original answer is
 * gone; what this returns is the grant as it stands now, bounded by the expiry
 * the caller signed for. A grant minted to 500 and renewed to 1500, resolved
 * under a signed cap of 1000, answers 1000: not the first answer, and never the
 * renewal's own lifetime. That is why the response separates the two expiries.
 *
 * It runs every check a mint runs — authority, session ownership, revoke state,
 * expiry — in the same read, because it hands out a credential. `requestId` is
 * the caller's signed correlation only; nothing about it is stored or matched.
 * A missing, revoked or expired grant is refused: this call cannot create one,
 * resurrect one, or extend one.
 */
export async function resolveSessionGrant(
    input: ResolveGrantInput,
): Promise<ResolveGrantResult> {
    const family = deriveGrantFamily(input.scope, input.purpose ?? 'runner');

    return inTx(async (tx) => {
        const authority = await tx.managedRunAuthority.findUnique({
            where: { runId: input.scope.runId },
            include: AUTHORITY_INCLUDE,
        });
        const mismatch = compareScope(authority as AuthorityRow | null, input.scope);
        if (mismatch) return { ok: false, reason: mismatch };

        const session = await tx.session.findUnique({
            where: { id: input.scope.sessionId },
            select: { accountId: true },
        });
        if (!session) return { ok: false, reason: 'session-unknown' };
        if (session.accountId !== input.scope.accountId) {
            return { ok: false, reason: 'session-owner-changed' };
        }

        const grant = await tx.managedSessionGrant.findUnique({ where: { family } });
        if (!grant || grant.tombstone) return { ok: false, reason: 'grant-unknown' };
        if (grant.revokedAt !== null) return { ok: false, reason: 'revoked' };
        // The row must be the one this exact scope was issued for. Without this
        // an authority advance leaves an old row that the fresh scope still
        // finds, and the answer would mix an old grant with a new DTO.
        if (compareStoredGrant(grant, input.scope, input.purpose ?? 'runner')) {
            return { ok: false, reason: 'grant-stale' };
        }

        const grantExpiresAt = Number(grant.expiresAt);
        if (!Number.isSafeInteger(grantExpiresAt)) return { ok: false, reason: 'expired' };
        if (input.now >= grantExpiresAt) return { ok: false, reason: 'expired' };
        // A cap that has already passed — or is not a real instant — authorises
        // nothing, and quietly widening it to the grant's own expiry would
        // ignore what was signed. `NaN` fails every comparison, so it is
        // rejected by shape rather than by `<=`.
        if (!Number.isSafeInteger(input.requestedTokenExpiresAt)
            || input.requestedTokenExpiresAt <= input.now) {
            return { ok: false, reason: 'already-expired' };
        }

        return {
            ok: true,
            resolved: {
                grant: toLiveGrant(grant),
                tokenExpiresAt: Math.min(grantExpiresAt, input.requestedTokenExpiresAt),
            },
        };
    });
}
