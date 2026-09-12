/**
 * Where a parent-issued checkpoint target waits until a checkpoint uses it.
 *
 * The targets are **pushed**, not fetched: the parent issues presigned URLs and
 * a one-shot key for a specific attempt and dispatches them, and the runtime
 * picks up what has been left for it. So `next()` does not ask anybody — it
 * takes what is here, and answers `null` when nothing is.
 *
 * ## One-shot, and why that is the whole point
 *
 * A target is consumed by the read. The key is live for exactly one checkpoint
 * and the URLs are signed for one attempt, so handing the same one to a second
 * checkpoint would seal a second archive under a key that is no longer secret
 * to that archive alone, and upload it to a key another attempt already owns.
 * Taking it out is what makes "one attempt, no reuse" a property of the code
 * rather than a rule callers are asked to remember.
 *
 * ## `null` means nothing is here — never "something failed"
 *
 * The coordinator treats `null` as an ordinary skip and a throw as the
 * runtime's problem. That split only holds if nothing here converts a failure
 * into an absence: a delivery that could not be authenticated, or an issuer
 * that could not be reached, never reaches this inbox at all — those are the
 * dispatch path's to raise. What lands here is a target that arrived.
 *
 * A target that arrived and then **expired** is a third thing: nobody failed,
 * and there is nothing usable. It is discarded and reported, because a stale
 * target used anyway fails at the upload, and one dropped in silence looks
 * exactly like an idle project.
 */
import type { KeyObject } from 'node:crypto';

import {
    canonicalManagedPayloadDigest,
    verifyManagedDispatchMaterial,
    type ManagedCheckpointTokenClaims,
} from '@/daemon/managedDispatchToken';
import type { CheckpointArea } from './managedCheckpointScope';
import {
    MANAGED_TARGET_MAX_BYTES,
    parseProviderStateScope,
    type ProviderStateScopeV1,
} from './managedProviderStateScope';
import type {
    ManagedCheckpointReceipt,
    ManagedCheckpointRequest,
} from './managedCheckpointRunner';
import type { ManagedCheckpointTargetSource } from './managedCheckpointCoordinator';

/** A target as the parent issues it: usable until `expiresAt`. */
export type ManagedCheckpointTargetDelivery = ManagedCheckpointRequest & {
    /**
     * Clamped by the parent to the write lease. An upload URL that outlives the
     * right to write is a permission that outlives its reason, and by then the
     * volume may belong to another runtime.
     */
    expiresAt: number;
    /**
     * Which sessions the parent says this checkpoint is meant to carry.
     *
     * Kept because the runtime has to compare it against the generation it is
     * actually holding, and it cannot compare against a document the parser
     * threw away.
     *
     * **Absent is the shape every target has today**, and it stays legal. It is
     * not permission to archive provider state and not evidence that no
     * provider ran - the publisher refuses either way, and this increment does
     * not relax that.
     */
    providerStateScope?: ProviderStateScopeV1;
};

/**
 * How an attempt for a checkpoint id ended, as far as anything can tell.
 *
 * A boolean was the first shape of this and it was wrong, because it made
 * "threw" mean "wrote nothing". Two facts about the publisher rule that out:
 *
 *  - objects and the manifest are uploaded with `ifAbsent: true`
 *    (`managedCheckpointPublisher.ts`), so a second attempt under the same id
 *    meets its own half-finished upload and is refused 412 — forever, not once.
 *  - the pointer PUT may have **succeeded** with the answer lost on the way
 *    back, so a throw is not evidence that nothing was published.
 *
 * So the only automatically retryable ending is one where nothing was written
 * at all. Anything else has to be resolved by looking at the store, not by
 * running again and hoping.
 */
export type CheckpointAttemptEnd =
    /** The pointer was published. Final. */
    | 'published'
    /** Nothing was uploaded, so the id is clean and may be delivered again. */
    | 'unstarted'
    /**
     * It stopped somewhere in between, or the answer was lost. What is in the
     * store is unknown, and a blind re-run would either 412 on its own objects
     * or seal over a checkpoint that already exists. The id is held until
     * something verifies the store; the parent's recovery is a new attempt id.
     */
    | 'uncertain';

/**
 * What happened to a delivery, and what the parent should do next.
 *
 * All four are **accepted** — the parent has been heard and must stop retrying
 * this hop. What differs is whether an archive is going to happen because of
 * it, which is the thing that must never be guessed:
 *
 *  - `queued`               it will be taken by the next checkpoint.
 *  - `replaced-unconsumed`  it replaced an earlier target nobody had taken yet.
 *  - `in-flight`            that id is running now. Ask again later.
 *  - `completed`    that id published its pointer. Final; move on.
 *  - `needs-verification`   an attempt for that id stopped without proving what
 *                           it had written. It may not simply run again — see
 *                           `settle`.
 */
export type ManagedCheckpointTargetAcceptance = {
    accepted: true;
    state: 'queued' | 'replaced-unconsumed' | 'in-flight' | 'completed' | 'needs-verification';
};

/**
 * The acceptance as the **wire** states it.
 *
 * `replaced-unconsumed` is this inbox's own word: a newer issue replaced one
 * nobody had taken yet. The parent's action for it is identical to `queued` —
 * an archive follows — and it is not in the agreed wire vocabulary, so a parent
 * that met it would classify it as a failure it must not retry, turning an
 * ordinary reissue into a checkpoint that never happens.
 *
 * The distinction is kept in `detail`, where it is diagnosis rather than
 * contract. Exported and used by the boundary rather than written there, so the
 * mapping is one thing that can be tested instead of a line inside a
 * process-wide bootstrap.
 */
export function wireStateForAcceptance(acceptance: ManagedCheckpointTargetAcceptance): {
    state: string;
    detail?: string;
} {
    return acceptance.state === 'replaced-unconsumed'
        ? { state: 'queued', detail: 'replaced-unconsumed' }
        : { state: acceptance.state };
}

export type ManagedCheckpointTargetInbox = ManagedCheckpointTargetSource & {
    /**
     * Takes delivery of a target.
     *
     * Replaces an unused one: a newer issue means the parent reissued, and the
     * older attempt's URLs are the stale pair. But an id that is **running** or
     * has **completed** is not queued again — see `settle`.
     */
    /**
     * `receipt` is what the boundary established about this target at receipt.
     *
     * Optional **at the type level only**, and not a permission to skip
     * authentication: the gate is `composeCheckpointTargetHandler`, which faces
     * the wire and refuses every target it cannot authenticate - including when
     * no authenticator is wired at all. Behind that gate this inbox makes no
     * claim of its own: with no receipt the request carries none, so nothing
     * can read an authentication that did not happen. It is optional because
     * the coordinator's own fixtures construct deliveries directly and belong
     * to another owner.
     */
    accept: (target: ManagedCheckpointTargetDelivery, receipt?: ManagedCheckpointReceipt)
        => ManagedCheckpointTargetAcceptance;
    /**
     * Reports how the attempt for an id ended. See `CheckpointAttemptEnd`.
     */
    settle: (input: { checkpointId: string; outcome: CheckpointAttemptEnd }) => void;
    /** Whether a usable target is waiting. For status, never for a decision. */
    pending: () => boolean;
};

export type { ManagedCheckpointReceipt };

/** Why a received target could not be authenticated. A closed set. */
export type ManagedCheckpointReceiptFailure =
    | 'wrong-project'
    | 'wrong-key'
    | 'checkpoint-mismatch'
    | 'request-key-mismatch';

/**
 * Authenticates a target the daemon relayed, with the supervisor's own marker.
 *
 * **This is authentication, not authorisation.** It establishes that the parent
 * signed *this document as it arrived*, for this runtime, workspace, project
 * and provisioning operation, within the token's own life, and that the token
 * names the checkpoint the params name. It establishes nothing about whether
 * that epoch is current, whether a promotion or revocation followed, or whether
 * anything may be written - the publisher's fail-closed refusals are untouched.
 *
 * `projectId` and `kid` are **not** inputs to the verifier: the daemon compares
 * them itself (`managedRpcHandlers.ts:522,525`), and a supervisor that left
 * them out would check less than the daemon does while holding more privilege.
 *
 * The digest is taken over `rawParams` - the document as it was parsed, before
 * the delivery was reconstructed from it. A digest over the reconstruction
 * cannot equal the signed one: `keyBase64` has become a Buffer and
 * `targets.areas[]` a Map.
 *
 * `requestKey` is checked, not merely recorded. The parent mints it as
 * `<provisioningOperationId>:<epoch>:checkpoint:<checkpointId>`
 * (`packages/web-ui/server/cloudCheckpointTargetIssuer.ts:546`), so it is
 * derivable here from the marker's own operation, the epoch the token was
 * signed with and the checkpoint the params name - no mutable state and no
 * guess. It binds the token to this provisioning a second way, independent of
 * the `provisioningOperationId` claim the verifier already compared.
 */
export function authenticateManagedCheckpointTarget(input: {
    rawParams: Record<string, unknown>;
    dispatchToken: string;
    checkpointId: string;
    authority: {
        verifier: KeyObject;
        runtimeId: string;
        workspaceId: string;
        projectId: string;
        keyId: string;
        provisioningOperationId: string;
    };
    now: number;
}): { ok: true; claims: ManagedCheckpointTokenClaims; receipt: ManagedCheckpointReceipt }
| { ok: false; reason: string } {
    const result = verifyManagedDispatchMaterial({
        token: input.dispatchToken,
        verifier: input.authority.verifier,
        runtimeId: input.authority.runtimeId,
        workspaceId: input.authority.workspaceId,
        op: 'checkpoint',
        paramsDigest: canonicalManagedPayloadDigest(input.rawParams),
        provisioningOperationId: input.authority.provisioningOperationId,
        now: input.now,
    });
    if (!result.ok) return result;
    const claims = result.claims as ManagedCheckpointTokenClaims;
    if (claims.projectId !== input.authority.projectId) return { ok: false, reason: 'wrong-project' };
    if (claims.kid !== input.authority.keyId) return { ok: false, reason: 'wrong-key' };
    if (claims.checkpointId !== input.checkpointId) return { ok: false, reason: 'checkpoint-mismatch' };
    const expectedRequestKey =
        `${input.authority.provisioningOperationId}:${claims.epoch}:checkpoint:${input.checkpointId}`;
    if (claims.requestKey !== expectedRequestKey) return { ok: false, reason: 'request-key-mismatch' };
    return {
        ok: true,
        claims,
        receipt: {
            epoch: claims.epoch,
            requestKey: claims.requestKey,
            issuedAtMs: claims.iat,
            expiresAtMs: claims.exp,
        },
    };
}

export function createManagedCheckpointTargetInbox(config: {
    now: () => number;
    /**
     * Told when a delivered target went unused until it expired. Not a failure
     * of anything, and not something to pass off as an idle project either.
     */
    onExpired?: (input: { checkpointId: string; expiredAtMs: number }) => void;
}): ManagedCheckpointTargetInbox {
    let waiting: ManagedCheckpointTargetDelivery | null = null;
    /*
     * Ids this runtime has handed to a checkpoint and not yet heard the end of.
     * A redelivery while one is here is the parent retrying a hop whose ACK was
     * lost — the archive is already running, and starting a second one would
     * seal the same volume twice under one id.
     */
    const inFlight = new Set<string>();
    /** Ids whose pointer was published. Final, for the life of this runtime. */
    const completed = new Set<string>();
    /** Ids whose attempt stopped without proving what it had written. */
    const unverified = new Set<string>();

    const takeUsable = (): ManagedCheckpointTargetDelivery | null => {
        if (!waiting) return null;
        if (config.now() >= waiting.expiresAt) {
            const expired = waiting;
            waiting = null;
            config.onExpired?.({ checkpointId: expired.checkpointId, expiredAtMs: expired.expiresAt });
            return null;
        }
        return waiting;
    };

    return {
        accept(target, receipt) {
            if (completed.has(target.checkpointId)) {
                return { accepted: true, state: 'completed' };
            }
            if (inFlight.has(target.checkpointId)) {
                return { accepted: true, state: 'in-flight' };
            }
            if (unverified.has(target.checkpointId)) {
                return { accepted: true, state: 'needs-verification' };
            }
            // `takeUsable` rather than the raw field: a target that expired
            // while waiting is not something a new one is replacing.
            const replaced = takeUsable() !== null;
            // Stored **on** the candidate: it is handed on with it and gone
            // with it, so nothing can read a receipt for a target that is no
            // longer here or lose one that is.
            waiting = receipt ? { ...target, receipt } : target;
            return { accepted: true, state: replaced ? 'replaced-unconsumed' : 'queued' };
        },

        settle({ checkpointId, outcome }) {
            inFlight.delete(checkpointId);
            if (outcome === 'published') { completed.add(checkpointId); return; }
            // `unstarted` is the only ending that returns an id to the pool:
            // nothing reached the store, so nothing there can collide with or
            // be overwritten by a later attempt under the same id.
            if (outcome === 'unstarted') return;
            unverified.add(checkpointId);
        },

        pending() {
            return takeUsable() !== null;
        },

        async next() {
            const usable = takeUsable();
            if (!usable) return null;
            // Consumed by the read: the key is live for one checkpoint and the
            // URLs are signed for one attempt. The id is in flight from here
            // until something reports how it ended.
            waiting = null;
            inFlight.add(usable.checkpointId);
            const { expiresAt: _expiresAt, ...request } = usable;
            return request satisfies ManagedCheckpointRequest;
        },
    };
}

/**
 * Reads a delivery off the wire.
 *
 * The document carries a one-shot key and signed upload URLs, so nothing about
 * its contents reaches an error, a log line, or a return value — a refusal says
 * which field was wrong and never what it held. Same rule as the bootstrap
 * envelope, and for the same reason.
 */
/**
 * A delivery, and the bytes it was built from.
 *
 * The signature the parent produced is over the params **as sent**. The
 * delivery is a reconstruction of them - `keyBase64` becomes a `Buffer`,
 * `targets.areas[]` becomes a `Map` - so a digest taken over the delivery is
 * not the digest that was signed, and verifying against it would always fail
 * or, worse, be made to pass by rebuilding the document the same wrong way on
 * both sides.
 *
 * So one parse returns both: `rawParams` for the signature, `delivery` for
 * everything downstream. The canonical digest only needs the parsed object -
 * it canonicalises key order itself - so the original lexical spelling does not
 * have to be kept alive.
 */
export type ManagedCheckpointTargetEnvelope = {
    rawParams: Record<string, unknown>;
    delivery: ManagedCheckpointTargetDelivery;
};

/**
 * Reads a delivery off the wire, keeping the document it came from.
 *
 * The rules are the ones `parseManagedCheckpointTargetDelivery` has always
 * applied; that function is now a wrapper over this one so every existing
 * caller keeps its exact behaviour and the two cannot drift apart.
 */
export function parseManagedCheckpointTargetEnvelope(raw: Buffer): ManagedCheckpointTargetEnvelope {
    /*
     * Size first, on the raw **bytes**, before `JSON.parse`.
     *
     * Parsing to discover the document was too large means having already paid
     * for it. Bytes rather than characters because `raw.toString().length`
     * undercounts every multi-byte character - and URLs are where those turn
     * up.
     */
    if (raw.length > MANAGED_TARGET_MAX_BYTES) {
        throw new Error('checkpoint target: document is too large');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.toString('utf8'));
    } catch {
        throw new Error('checkpoint target: is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('checkpoint target: must be an object');
    }
    const record = parsed as Record<string, unknown>;
    const checkpointId = record.checkpointId;
    if (typeof checkpointId !== 'string' || !/^[a-f0-9]{64}$/.test(checkpointId)) {
        throw new Error('checkpoint target: checkpointId is not a digest');
    }
    const expiresAt = record.expiresAt;
    if (!Number.isSafeInteger(expiresAt)) {
        throw new Error('checkpoint target: expiresAt must be an integer');
    }
    const keyBase64 = record.keyBase64;
    if (typeof keyBase64 !== 'string') throw new Error('checkpoint target: key must be base64');
    const key = Buffer.from(keyBase64, 'base64');
    // The archive's own floor. A short key is refused here rather than at the
    // seal, where it would read as a crypto failure.
    if (key.length !== 32) throw new Error('checkpoint target: key must decode to 32 bytes');

    const targets = record.targets;
    if (!targets || typeof targets !== 'object') {
        throw new Error('checkpoint target: targets must be an object');
    }
    const shape = targets as Record<string, unknown>;
    const objectTarget = (value: unknown, field: string): { putUrl: string; headUrl: string } => {
        const entry = value as Record<string, unknown> | undefined;
        if (!entry || typeof entry.putUrl !== 'string' || typeof entry.headUrl !== 'string') {
            throw new Error(`checkpoint target: ${field} needs a putUrl and a headUrl`);
        }
        // Signed separately on purpose: a presigned URL authorises the method
        // it was signed for, so one URL doing both is the wider permission.
        return { putUrl: entry.putUrl, headUrl: entry.headUrl };
    };
    const rawAreas = shape.areas;
    if (!Array.isArray(rawAreas) || rawAreas.length === 0) {
        throw new Error('checkpoint target: areas must be a non-empty array');
    }
    const objects = new Map<CheckpointArea, { putUrl: string; headUrl: string }>();
    for (const entry of rawAreas) {
        const area = (entry as { area?: unknown }).area;
        if (area !== 'project' && area !== 'provider-state') {
            throw new Error('checkpoint target: unknown area');
        }
        objects.set(area, objectTarget(entry, `areas.${area}`));
    }
    const pointer = shape.pointer as Record<string, unknown> | undefined;
    if (!pointer || typeof pointer.putUrl !== 'string' || typeof pointer.getUrl !== 'string') {
        // `getUrl`, not a precomputed etag: the publisher reads the pointer
        // itself and conditions the PUT on what it read, because an etag taken
        // at issue time is stale by exactly the window CAS exists to close.
        throw new Error('checkpoint target: pointer needs a putUrl and a getUrl');
    }
    /*
     * Parsed, not passed through. A scope this runtime cannot read makes the
     * whole delivery unusable - dropping it and carrying on would leave the
     * runtime acting on a target whose terms it never understood.
     */
    const providerStateScope = record.providerStateScope === undefined
        ? undefined
        : parseProviderStateScope(record.providerStateScope);

    return {
        // The document as it arrived, for the signature.
        rawParams: record,
        delivery: {
            checkpointId,
            key,
            expiresAt: expiresAt as number,
            ...(providerStateScope ? { providerStateScope } : {}),
            targets: {
                objects,
                manifest: objectTarget(shape.manifest, 'manifest'),
                pointer: { putUrl: pointer.putUrl, getUrl: pointer.getUrl },
            },
        },
    };
}

/**
 * The delivery alone.
 *
 * Kept because every existing caller wants exactly this and nothing more; it is
 * a wrapper rather than a second parser so there is one set of rules.
 */
export function parseManagedCheckpointTargetDelivery(raw: Buffer): ManagedCheckpointTargetDelivery {
    return parseManagedCheckpointTargetEnvelope(raw).delivery;
}
