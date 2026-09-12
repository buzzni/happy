/**
 * The last runtime-scoped grant this supervisor authenticated.
 *
 * ## What this is
 *
 * An **authenticated statement by the parent**: it signed this runtime lease,
 * for this runtime, workspace, project, key and provisioning operation, at this
 * epoch and renewal sequence, within the token's own life.
 *
 * ## What it is not — every one of these has to stay false
 *
 * - **not proof the enforcement completed.** The daemon's fan-out to each
 *   generation happens *after* this, and can still refuse.
 * - **not a commit.** `writeLease` happens after, and can fail with this
 *   snapshot already advanced. That divergence is expected and left legible
 *   rather than hidden.
 * - **not current authority.** A promotion or revocation the parent committed
 *   since is invisible here.
 * - **not a fence.** The fence is the daemon's, before this.
 * - `absent` means **unknown** — never "valid", never "revoked".
 *
 * No current epoch is synthesised anywhere: `claims.epoch` is compared only
 * against this snapshot's own previous value, which is the parent's own earlier
 * statement rather than an authority.
 *
 * ## Why the whole admission is synchronous
 *
 * Authenticate, then take a **fresh** wall and monotonic sample, then compare,
 * then store — with no `await` anywhere between. A clock read before
 * authentication and stored after it would record a window computed from a time
 * that has already passed, and an await between the compare and the store would
 * let a second grant interleave into a mixture of the two. The freshly sampled
 * wall clock re-decides `exp` even though the verification just used one, so
 * the stored window and the admission decision are made from the same instant.
 */
import type { KeyObject } from 'node:crypto';

import {
    canonicalManagedPayloadDigest,
    verifyManagedDispatchMaterial,
    type ManagedRuntimeLeaseTokenClaims,
} from '@/daemon/managedDispatchToken';

/** Everything the marker contributes. All of it is root-owned. */
export type ManagedRuntimeGrantAuthority = {
    verifier: KeyObject;
    runtimeId: string;
    workspaceId: string;
    projectId: string;
    keyId: string;
    provisioningOperationId: string;
};

export type ManagedRuntimeGrant =
    | { kind: 'absent' }
    | {
        kind: 'present';
        /** `E_t`: the epoch the parent signed for. A fact, not an authority. */
        epoch: number;
        renewalSeq: number;
        /** The ceiling the parent signed, in its own wall clock. */
        absoluteExpiry: number;
        /** This supervisor's own deadline, on its own monotonic clock. */
        deadlineMonotonic: number;
        authenticatedAtMonotonic: number;
    };

export type ManagedRuntimeGrantSnapshot = {
    /**
     * Authenticate a relayed grant and, if it moves forward, record it.
     *
     * Synchronous by contract, not by accident — see the header.
     */
    admit: (input: { dispatchToken: string; rawParams: Record<string, unknown> })
        => { ok: true } | { ok: false; reason: string };
    /**
     * An observation, handed back as a **copy**.
     *
     * Returning the held object would make this an accessor: a reader writing
     * to it would move the sequence the next admission compares against, and a
     * replay refused a moment ago would then be admitted. Every field is
     * primitive, so one shallow copy is the whole fix.
     */
    current: () => ManagedRuntimeGrant;
    /**
     * Back to unknown. Called after the IPC server has drained and the lock is
     * released — never before, or a handler still in flight would write into a
     * snapshot that is supposed to be gone.
     */
    clear: () => void;
};

export function createManagedRuntimeGrantSnapshot(config: {
    authority: ManagedRuntimeGrantAuthority;
    now: () => number;
    monotonicNow: () => number;
}): ManagedRuntimeGrantSnapshot {
    let held: ManagedRuntimeGrant = { kind: 'absent' };

    return {
        admit({ dispatchToken, rawParams }) {
            const verified = verifyManagedDispatchMaterial({
                token: dispatchToken,
                verifier: config.authority.verifier,
                runtimeId: config.authority.runtimeId,
                workspaceId: config.authority.workspaceId,
                op: 'runtime-lease',
                paramsDigest: canonicalManagedPayloadDigest(rawParams),
                provisioningOperationId: config.authority.provisioningOperationId,
                now: config.now(),
            });
            if (!verified.ok) return verified;
            const claims = verified.claims as ManagedRuntimeLeaseTokenClaims;

            /*
             * The two the verifier does not do. The daemon compares them
             * itself (`managedRpcHandlers.ts:522,525`), and a supervisor that
             * skipped them would check less than the daemon does while holding
             * more privilege.
             */
            if (claims.projectId !== config.authority.projectId) {
                return { ok: false, reason: 'wrong-project' };
            }
            if (claims.kid !== config.authority.keyId) return { ok: false, reason: 'wrong-key' };
            /*
             * The parent's own shape for a runtime lease:
             * `<provisioningOperationId>:<epoch>:<op>`
             * (`packages/web-ui/server/cloudRuntimeReadinessPorts.ts:298`).
             *
             * **No id tail**, unlike a checkpoint's. Sharing one expression
             * between the two would refuse every real grant here.
             */
            const expected =
                `${config.authority.provisioningOperationId}:${claims.epoch}:runtime-lease`;
            if (claims.requestKey !== expected) {
                return { ok: false, reason: 'request-key-mismatch' };
            }
            /*
             * The parent builds the params and the lease claim from one number
             * (`cloudRuntimeReadinessPorts.ts:365,384`). A token whose two
             * disagree did not come from that path.
             *
             * This is a **producer-contract check, not a signature gap**: both
             * values are already covered - `leaseMs` is a signed claim, and
             * `payloadDigest` binds `requestedMs` - so neither can be edited in
             * transit. What the signature cannot say is that the issuer built
             * them from one number, and that is what is checked here.
             */
            if (rawParams.requestedMs !== claims.leaseMs) {
                return { ok: false, reason: 'grant-malformed' };
            }

            // One fresh sample, used for every decision below and for what is
            // stored. `exp` is re-decided here even though the verification
            // above just read a clock: those are two reads, and only this one
            // is the instant the window is computed from.
            const wall = config.now();
            const monotonic = config.monotonicNow();
            if (claims.exp <= wall) return { ok: false, reason: 'expired' };

            /*
             * The mirror of the daemon's `clampLease`
             * (`managedRpcHandlers.ts:493`), computed here rather than taking
             * the daemon's `leaseExpiresMonotonic`: the deadline this process
             * will be judged by must come from this process's own clocks.
             *
             * No ceiling rule on `absoluteExpiry` is needed - `leaseMs` is
             * already bounded by the token parser, so an absurd expiry cannot
             * widen the window.
             */
            const grantedMs = Math.max(0, Math.min(claims.leaseMs, claims.absoluteExpiry - wall));
            if (grantedMs === 0) return { ok: false, reason: 'grant-window-exhausted' };

            /*
             * Forward only, against this supervisor's own previous snapshot.
             * Equal is refused strictly: the parent allocates a **new higher**
             * sequence for every retry, so an equal one is a replay or a
             * resend, and admitting it would move a deadline.
             */
            if (held.kind === 'present') {
                if (claims.epoch < held.epoch) return { ok: false, reason: 'grant-stale-epoch' };
                if (claims.epoch === held.epoch && claims.renewalSeq <= held.renewalSeq) {
                    return { ok: false, reason: 'grant-stale-renewal' };
                }
            }

            held = {
                kind: 'present',
                epoch: claims.epoch,
                renewalSeq: claims.renewalSeq,
                absoluteExpiry: claims.absoluteExpiry,
                deadlineMonotonic: monotonic + grantedMs,
                authenticatedAtMonotonic: monotonic,
            };
            return { ok: true };
        },

        current() {
            return held.kind === 'absent' ? { kind: 'absent' } : { ...held };
        },

        clear() {
            held = { kind: 'absent' };
        },
    };
}
