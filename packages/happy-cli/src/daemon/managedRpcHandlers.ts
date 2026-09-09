/**
 * The managed RPC surface, and the refusals that keep the legacy surface shut.
 *
 * Registration is the advertisement: these handlers exist only on a runtime
 * whose provisioning and isolation were verified, so a BYOS machine never
 * announces them and a server probing for them gets "RPC method not available".
 *
 * Two invariants run through every handler:
 *   - Nothing executes before the durable receipt for it exists.
 *   - No answer claims more than was observed. `managed:stop` returns that a
 *     stop was accepted and what was seen locally, never that a session ended.
 */

import {
    canonicalManagedPayloadDigest,
    verifyManagedDispatchToken,
    type ManagedOp,
    type ManagedTokenClaims,
} from './managedDispatchToken';
import {
    classifyManagedReceipt,
    managedOperationKey,
    type ManagedReceipt,
    type ManagedReceiptStore,
} from './managedReceiptStore';
import {
    probeProcessGroup,
    requestProcessGroupStop,
    summarizeFencingEvidence,
    type ProcessGroupDeps,
    type ProcessGroupEvidence,
} from './managedProcessGroup';
import type { ManagedRuntimeIdentity } from './managedRuntimeIdentity';

export const MANAGED_RPC_METHODS = [
    'managed:spawn', 'managed:stop', 'managed:receipt', 'managed:lease',
] as const;

const DEFAULT_STOP_GRACE_MS = 10_000;

export type ManagedSpawnRequest = {
    directory: string;
    agent?: string;
    environmentVariables?: Record<string, string>;
    initialPrompt?: string;
    initialPromptLocalId?: string;
};

export type ManagedSpawnOutcome =
    | { type: 'success'; sessionId: string; pid: number }
    /**
     * `started: false` is the only evidence that lets a run be recorded as
     * failed. Without it the child may already exist, so the receipt stays
     * uncertain and reconcilable rather than closed.
     */
    | { type: 'error'; errorMessage: string; started: false }
    | { type: 'error'; errorMessage: string; started?: undefined };

/**
 * What the launcher is told about the request, taken from the verified token
 * and never from the caller-supplied params. A privileged launcher (T09) needs
 * this to check the in-flight epoch and any stop tombstone atomically with the
 * exec it performs; `request` alone cannot be trusted for that.
 */
export type ManagedSpawnContext = {
    operationKey: string;
    runId: string;
    attemptId: string;
    epoch: number;
    workspaceId: string;
    projectId: string;
    /** Monotonic instant after which this runtime may no longer write. */
    leaseExpiresMonotonic: number;
};

export type ManagedRuntime = {
    identity: ManagedRuntimeIdentity;
    store: ManagedReceiptStore;
    /** Performs the actual spawn. Must return the child's pid on success. */
    spawn: (request: ManagedSpawnRequest, context: ManagedSpawnContext) => Promise<ManagedSpawnOutcome>;
    isPidAlive: (pid: number) => boolean;
    now: () => number;
    /** Monotonic clock. Wall-clock jumps must not extend a write lease. */
    monotonicNow: () => number;
    processGroupDeps?: ProcessGroupDeps;
    stopGraceMs?: number;
    /**
     * The privileged launch backend. It is the only thing that can prove a
     * previous generation is gone, and the only thing that can stop a child
     * running under the agent uid. T09 provides it; until then it is absent and
     * every path that needs it fails closed.
     */
    fencingBackend?: {
        proveGenerationStopped: (input: { belowEpoch: number }) => Promise<{ proven: boolean; detail: string }>;
        /**
         * Addressed by the identifiers that outlive this process. A pgid is a
         * number that the kernel may have reused, and means nothing to a
         * backend that survives a daemon restart.
         */
        requestStop: (input: {
            runId: string; attemptId: string; epoch: number; pgid: number | null;
        }) => Promise<{ requested: boolean; detail: string }>;
    };
};

type RpcRegistrar = { registerHandler: (method: string, handler: (params: unknown) => unknown) => void };

/** Refusals the caller can act on, distinct from a crash. */
export class ManagedRpcError extends Error {
    constructor(readonly code: string, detail?: string) {
        // The code leads so a caller can branch on it without parsing prose,
        // and the detail is only ever a short classifier — never provider text.
        super(detail ? `${code}: ${detail}` : code);
        this.name = 'ManagedRpcError';
    }
}

function receiptView(receipt: ManagedReceipt, runtime: ManagedRuntime) {
    return {
        operationKey: receipt.requestKey,
        runId: receipt.runId,
        attemptId: receipt.attemptId,
        state: receipt.state,
        epoch: receipt.epoch,
        sessionId: receipt.sessionId,
        stopRequested: receipt.stopRequestedAt !== null,
        certainty: classifyManagedReceipt(receipt, runtime.isPidAlive),
        updatedAt: receipt.updatedAt,
    };
}

export function createManagedRpcHandlers(runtime: ManagedRuntime) {
    const stopGraceMs = runtime.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;

    /**
     * The usable write deadline lives only in memory, on a monotonic clock. A
     * restart therefore starts expired and the runtime must obtain a freshly
     * signed lease before it may execute anything.
     */
    let leaseUntilMonotonic: number | null = null;

    const leaseValid = () => leaseUntilMonotonic !== null && runtime.monotonicNow() < leaseUntilMonotonic;

    const clampLease = (leaseMs: number, absoluteExpiry: number): number =>
        Math.max(0, Math.min(leaseMs, absoluteExpiry - runtime.now()));

    const storedLease = () => {
        const lease = runtime.store.readLease();
        if (lease.kind === 'unknown') {
            // Falling back to epoch 0 / seq 0 would re-accept a spent renewal.
            throw new ManagedRpcError('lease-state-unreadable', lease.detail);
        }
        return lease.kind === 'absent'
            ? { epoch: 0, renewalSeq: 0 }
            : { epoch: lease.record.epoch, renewalSeq: lease.record.renewalSeq };
    };

    const verify = (op: ManagedOp, params: unknown): ManagedTokenClaims => {
        if (!params || typeof params !== 'object' || Array.isArray(params)) {
            throw new ManagedRpcError('malformed-request');
        }
        const record = params as Record<string, unknown>;
        const token = record.token;
        if (typeof token !== 'string') throw new ManagedRpcError('malformed-request');
        const payload = record.params ?? {};
        const result = verifyManagedDispatchToken({
            token,
            verifier: runtime.identity.verifier,
            runtimeId: runtime.identity.runtimeId,
            workspaceId: runtime.identity.workspaceId,
            op,
            paramsDigest: canonicalManagedPayloadDigest(payload),
            currentEpoch: storedLease().epoch,
            now: runtime.now(),
        });
        if (!result.ok) throw new ManagedRpcError(`token-${result.reason}`);
        // Audience and workspace are checked inside the verifier; project and
        // key id are this runtime's trusted identity and are checked here so a
        // token minted for a sibling project cannot act on this workspace.
        if (result.claims.projectId !== runtime.identity.projectId) {
            throw new ManagedRpcError('token-wrong-project');
        }
        if (result.claims.kid !== runtime.identity.keyId) {
            throw new ManagedRpcError('token-unknown-key');
        }
        return result.claims;
    };

    /** pgids this process actually spawned. A persisted number is not ownership. */
    const spawnedHere = new Set<number>();

    /** Serializes lease renewal and epoch transition against each other. */
    let leaseChain: Promise<unknown> = Promise.resolve();
    let transitioning = false;
    /** Spawns that passed admission but have not reached the launcher yet. */
    let spawnsInFlight = 0;

    const serializeLease = <T>(work: () => Promise<T>): Promise<T> => {
        const next = leaseChain.then(work, work);
        leaseChain = next.then(() => undefined, () => undefined);
        return next;
    };

    const stopGroup = async (receipt: ManagedReceipt): Promise<ProcessGroupEvidence> => {
        if (receipt.pgid === null) return { kind: 'no-local-trace' };
        const outcome = await requestProcessGroupStop({
            pgid: receipt.pgid,
            graceMs: stopGraceMs,
            ownership: spawnedHere.has(receipt.pgid)
                ? { kind: 'live-tracked-child' }
                : { kind: 'unverified' },
            ...(runtime.processGroupDeps ? { deps: runtime.processGroupDeps } : {}),
        });
        if (outcome.deferredTo === 'privileged-backend' && runtime.fencingBackend) {
            await runtime.fencingBackend.requestStop({
                runId: receipt.runId,
                attemptId: receipt.attemptId,
                epoch: receipt.epoch,
                pgid: receipt.pgid,
            });
        }
        return outcome.evidence;
    };

    return {
        /**
         * Accepts a request at most once. A retry of the same attempt returns
         * the existing receipt without starting anything; an intentional new
         * attempt arrives under a different operation key.
         */
        async spawn(params: unknown) {
            const claims = verify('spawn', params);
            if (!leaseValid()) throw new ManagedRpcError('lease-expired');
            // An epoch transition is in progress; starting work now would race
            // the fence it is trying to establish.
            if (transitioning) throw new ManagedRpcError('epoch-transition-in-progress');

            const payloadDigest = canonicalManagedPayloadDigest(
                (params as Record<string, unknown>).params ?? {},
            );
            const key = managedOperationKey({ runId: claims.runId, attemptId: claims.attemptId });

            /** A duplicate is only a retry when its scope and payload match. */
            const asDuplicate = (receipt: ManagedReceipt) => {
                if (receipt.state === 'tombstone') {
                    // A stop reached the runtime before this dispatch did.
                    throw new ManagedRpcError('stopped-before-dispatch');
                }
                const sameScope = receipt.workspaceId === claims.workspaceId
                    && receipt.projectId === claims.projectId
                    && receipt.runId === claims.runId
                    && receipt.attemptId === claims.attemptId
                    && receipt.epoch === claims.epoch;
                // Answering a different payload with the first result would
                // merge two distinct requests into one outcome.
                if (!sameScope || (receipt.spawnPayloadDigest !== null && receipt.spawnPayloadDigest !== payloadDigest)) {
                    throw new ManagedRpcError('operation-payload-conflict');
                }
                return { accepted: true, receipt: receiptView(receipt, runtime) };
            };

            const existing = runtime.store.read(key);
            if (existing.kind === 'unknown') {
                throw new ManagedRpcError('reconciliation-required', existing.detail);
            }
            if (existing.kind === 'ok') return asDuplicate(existing.receipt);

            const claimed = runtime.store.claim({
                requestKey: key,
                runId: claims.runId,
                attemptId: claims.attemptId,
                epoch: claims.epoch,
                workspaceId: claims.workspaceId,
                projectId: claims.projectId,
                spawnPayloadDigest: payloadDigest,
                now: runtime.now(),
            });
            if (claimed.kind === 'corrupt') throw new ManagedRpcError('reconciliation-required', 'corrupt receipt');
            if (claimed.kind === 'exists') return asDuplicate(claimed.receipt);

            const request = ((params as Record<string, unknown>).params ?? {}) as ManagedSpawnRequest;
            // Recorded *before* the spawn: a crash after this point is
            // uncertain and must go to reconciliation rather than be retried.
            runtime.store.update(key, { state: 'spawning', spawnAt: runtime.now() }, runtime.now());

            // Re-checked here because a fence may have begun while this request
            // was between admission and the launcher.
            if (transitioning || !leaseValid()) {
                throw new ManagedRpcError('epoch-transition-in-progress');
            }

            // Everything the launcher is told comes from the verified token.
            const context: ManagedSpawnContext = {
                operationKey: key,
                runId: claims.runId,
                attemptId: claims.attemptId,
                epoch: claims.epoch,
                workspaceId: claims.workspaceId,
                projectId: claims.projectId,
                leaseExpiresMonotonic: leaseUntilMonotonic ?? 0,
            };

            let outcome: ManagedSpawnOutcome;
            spawnsInFlight += 1;
            try {
                outcome = await runtime.spawn(request, context);
            } catch {
                // No typed evidence that nothing started: a child may exist and
                // still be writing. The receipt stays `spawning` so a query or a
                // backend stop can still reach it. The original message is not
                // propagated — it carries paths, tokens and request content.
                throw new ManagedRpcError('reconciliation-required', 'spawn outcome unknown');
            } finally {
                spawnsInFlight -= 1;
            }

            if (outcome.type === 'error') {
                if (outcome.started === false) {
                    runtime.store.update(key, {
                        state: 'failed', failureReason: 'not-started',
                    }, runtime.now());
                    throw new ManagedRpcError('spawn-rejected');
                }
                throw new ManagedRpcError('reconciliation-required', 'spawn outcome unknown');
            }

            // The child is detached, so it leads its own process group, and it
            // was started here — which is what makes signalling it legitimate.
            spawnedHere.add(outcome.pid);
            const after = runtime.store.update(key, {
                state: 'running',
                pid: outcome.pid,
                pgid: outcome.pid,
                sessionId: outcome.sessionId,
            }, runtime.now());

            // A stop that arrived while the spawn was in flight is honoured now
            // that there is something to signal.
            if (after.stopRequestedAt !== null) {
                const evidence = await stopGroup(after);
                const stopped = runtime.store.update(key, { state: 'stopping' }, runtime.now());
                return { accepted: true, receipt: receiptView(stopped, runtime), localEvidence: evidence };
            }
            return { accepted: true, receipt: receiptView(after, runtime) };
        },

        /**
         * Accepts a stop. The answer reports acceptance and local evidence; it
         * never asserts that the session ended, because a child that called
         * `setsid` is invisible to every check available here.
         */
        async stop(params: unknown) {
            const claims = verify('stop', params);
            const key = managedOperationKey({ runId: claims.runId, attemptId: claims.attemptId });
            const existing = runtime.store.read(key);

            if (existing.kind === 'unknown') {
                throw new ManagedRpcError('reconciliation-required', existing.detail);
            }
            if (existing.kind === 'absent') {
                // The stop overtook the dispatch. A durable tombstone makes the
                // later spawn refuse instead of starting work that was cancelled.
                const tomb = runtime.store.tombstone({
                    requestKey: key,
                    runId: claims.runId,
                    attemptId: claims.attemptId,
                    epoch: claims.epoch,
                    workspaceId: claims.workspaceId,
                    projectId: claims.projectId,
                    now: runtime.now(),
                });
                if (tomb.kind === 'corrupt') throw new ManagedRpcError('reconciliation-required', 'corrupt receipt');
                if (tomb.kind === 'exists') {
                    return { accepted: true, receipt: receiptView(tomb.receipt, runtime) };
                }
                return { accepted: true, receipt: receiptView(tomb.receipt, runtime) };
            }

            const receipt = existing.receipt;
            if (receipt.state === 'spawning') {
                // No pid yet; the spawn path consumes this flag once it has one.
                const marked = runtime.store.update(key, { stopRequestedAt: runtime.now() }, runtime.now());
                return { accepted: true, receipt: receiptView(marked, runtime) };
            }
            if (receipt.state === 'stopped' || receipt.state === 'failed' || receipt.state === 'tombstone') {
                return { accepted: true, receipt: receiptView(receipt, runtime) };
            }

            const marked = runtime.store.update(key, {
                state: 'stopping', stopRequestedAt: runtime.now(),
            }, runtime.now());
            const evidence = await stopGroup(marked);
            return { accepted: true, receipt: receiptView(marked, runtime), localEvidence: evidence };
        },

        /** Durable receipt lookup — the only way to resolve a lost ACK. */
        receipt(params: unknown) {
            const claims = verify('query', params);
            // Only the run and attempt the token was signed for. A listing of
            // everything would let one signed query enumerate the workspace.
            const key = managedOperationKey({ runId: claims.runId, attemptId: claims.attemptId });
            const found = runtime.store.read(key);
            if (found.kind === 'unknown') {
                return { receipts: [], unknown: [{ file: 'requested', detail: found.detail }] };
            }
            return {
                receipts: found.kind === 'ok' ? [receiptView(found.receipt, runtime)] : [],
                unknown: [],
            };
        },

        /**
         * Renews the write lease and, when the server raises the epoch, performs
         * the local part of fencing.
         *
         * A higher epoch is only persisted when nothing of the previous
         * generation is visible here. That is a necessary condition, not a
         * sufficient one: the server must still hold provider-level proof
         * (T09) before it treats the new generation as writable.
         */
        async lease(params: unknown) {
            const claims = verify('lease', params);
            if (claims.renewalSeq === undefined || claims.leaseMs === undefined
                || claims.absoluteExpiry === undefined) {
                throw new ManagedRpcError('malformed-request');
            }
            // Renewal and epoch transition are serialized: two interleaved
            // renewals could otherwise commit out of order and walk the
            // sequence backwards, which is exactly what replay protection
            // depends on not happening.
            return serializeLease(async () => {
                const stored = storedLease();
                // Checked inside the queue: a request minted at an older epoch
                // can arrive after a promotion committed, and writing it back
                // would reopen the generation that was just fenced.
                if (claims.epoch < stored.epoch) throw new ManagedRpcError('stale-epoch');
                if (claims.renewalSeq! <= stored.renewalSeq) throw new ManagedRpcError('stale-renewal');

                if (claims.epoch > stored.epoch) {
                    transitioning = true;
                    try {
                        // Raising the epoch opens a new writable generation.
                        // Nothing observable from inside this process can prove
                        // the previous one is gone — a child that called setsid
                        // is invisible here — so the promotion requires the
                        // privileged backend to say so. Without that backend the
                        // epoch and the deadline both stay where they are.
                        if (!runtime.fencingBackend) {
                            throw new ManagedRpcError('fence-proof-unavailable', 'no privileged launch backend');
                        }
                        const listing = runtime.store.list();
                        if (listing.listError || listing.unknown.length > 0) {
                            throw new ManagedRpcError('fence-incomplete', 'receipt store not fully readable');
                        }
                        // A receipt without a pgid is not evidence of nothing
                        // running: `spawning` means a child may exist whose pid
                        // was never recorded.
                        const live = listing.receipts.filter((receipt) => (
                            receipt.epoch < claims.epoch
                            && receipt.state !== 'stopped'
                            && receipt.state !== 'tombstone'
                            && !(receipt.state === 'failed' && receipt.failureReason === 'not-started')
                        ));
                        const evidence: ProcessGroupEvidence[] = [];
                        for (const receipt of live) evidence.push(await stopGroup(receipt));
                        const summary = summarizeFencingEvidence(evidence);

                        const proof = await runtime.fencingBackend.proveGenerationStopped({
                            belowEpoch: claims.epoch,
                        });
                        if (!proof.proven) {
                            throw new ManagedRpcError('fence-proof-unavailable', proof.detail);
                        }
                        if (!summary.allClear) {
                            throw new ManagedRpcError('fence-incomplete', summary.reasons.join(','));
                        }

                        // Re-validated after the awaits above: another renewal
                        // may have committed, the token may have aged out, and
                        // a spawn admitted before the fence may still be
                        // reaching the launcher.
                        if (claims.exp <= runtime.now()) throw new ManagedRpcError('token-expired');
                        if (spawnsInFlight > 0) {
                            throw new ManagedRpcError('fence-incomplete', 'spawn in flight');
                        }
                        const latest = storedLease();
                        if (claims.renewalSeq! <= latest.renewalSeq || claims.epoch < latest.epoch) {
                            throw new ManagedRpcError('stale-renewal');
                        }
                        runtime.store.writeLease({
                            epoch: claims.epoch,
                            renewalSeq: claims.renewalSeq!,
                            updatedAt: runtime.now(),
                        });
                        const grantedMs = clampLease(claims.leaseMs!, claims.absoluteExpiry!);
                        leaseUntilMonotonic = runtime.monotonicNow() + grantedMs;
                        return {
                            ok: true,
                            epoch: claims.epoch,
                            renewalSeq: claims.renewalSeq,
                            grantedMs,
                            fenced: true,
                            localEvidence: evidence,
                        };
                    } finally {
                        transitioning = false;
                    }
                }

                runtime.store.writeLease({
                    epoch: claims.epoch,
                    renewalSeq: claims.renewalSeq!,
                    updatedAt: runtime.now(),
                });
                const grantedMs = clampLease(claims.leaseMs!, claims.absoluteExpiry!);
                leaseUntilMonotonic = runtime.monotonicNow() + grantedMs;
                return {
                    ok: true,
                    epoch: claims.epoch,
                    renewalSeq: claims.renewalSeq,
                    grantedMs,
                    fenced: false,
                    localEvidence: [] as ProcessGroupEvidence[],
                };
            });
        },

        /**
         * What to do when the write lease runs out while children are still
         * running. Refusing new work is not enough — an agent turn started
         * before the expiry keeps writing.
         *
         * This asks the privileged backend to stop them. With no backend the
         * honest answer is that nothing here can, so it reports
         * `actionRequired` instead of a clean stop.
         */
        async enforceLeaseExpiry() {
            if (leaseValid()) return { expired: false, actionRequired: false, live: [] as string[] };
            const listing = runtime.store.list();
            // A receipt without a pgid is included on purpose: `spawning` means
            // a child may exist whose pid was never recorded, and skipping it
            // would leave exactly the case nobody can see.
            const live = listing.receipts.filter((receipt) => (
                receipt.state === 'spawning' || receipt.state === 'spawned'
                || receipt.state === 'running' || receipt.state === 'stopping'
            ));

            const handled: string[] = [];
            for (const receipt of live) {
                await stopGroup(receipt);
                if (runtime.fencingBackend) {
                    await runtime.fencingBackend.requestStop({
                        runId: receipt.runId,
                        attemptId: receipt.attemptId,
                        epoch: receipt.epoch,
                        pgid: receipt.pgid,
                    });
                }
                handled.push(receipt.requestKey);
            }

            // `no-local-trace` says only that nothing is visible from here, so
            // it can never clear this on its own. Only the backend's proof can.
            let proven = false;
            if (runtime.fencingBackend && live.length > 0) {
                const proof = await runtime.fencingBackend.proveGenerationStopped({
                    belowEpoch: Number.MAX_SAFE_INTEGER,
                });
                proven = proof.proven;
            }
            const storeUnreadable = listing.unknown.length > 0 || listing.listError !== undefined;
            return {
                expired: true,
                actionRequired: live.length > 0 ? !proven || storeUnreadable : storeUnreadable,
                live: handled,
            };
        },

        /** Exposed for wiring tests: is the runtime currently allowed to work? */
        isLeaseValid: leaseValid,
        probeGroup: (pgid: number) => probeProcessGroup(pgid, runtime.processGroupDeps),
    };
}

export type ManagedRpcHandlers = ReturnType<typeof createManagedRpcHandlers>;

export function registerManagedRpcHandlers(
    registrar: RpcRegistrar,
    handlers: ManagedRpcHandlers,
): void {
    registrar.registerHandler('managed:spawn', (params) => handlers.spawn(params));
    registrar.registerHandler('managed:stop', (params) => handlers.stop(params));
    registrar.registerHandler('managed:receipt', (params) => handlers.receipt(params));
    registrar.registerHandler('managed:lease', (params) => handlers.lease(params));
}

/**
 * The only RPC methods a managed runtime serves.
 *
 * An allowlist, not a denylist: a denylist silently admits every method added
 * later, and the point of this gate is that a future RPC cannot become a bypass
 * simply by existing.
 */
export const MANAGED_ALLOWED_RPCS: readonly string[] = [
    'managed:spawn',
    'managed:stop',
    'managed:receipt',
    'managed:lease',
];

export class ManagedCapabilityError extends Error {
    readonly code = 'MANAGED_CAPABILITY_REQUIRED';
    constructor(method: string) {
        super(`${method} is not available on a managed runtime; use the managed dispatch RPCs`);
        this.name = 'ManagedCapabilityError';
    }
}

type RestrictableRegistrar = {
    setManagedAllowlist?: (methods: readonly string[]) => void;
};

/**
 * Fixes the served surface at the dispatch boundary.
 *
 * Rewriting individual registrations was not enough: anything registered after
 * such a sweep, and any path reaching a handler without going through
 * registration, would still be reachable. The manager itself refuses instead.
 *
 * Transports outside this manager — the loopback control server and the
 * terminal WebSocket — are gated at their own entry points.
 */
export function applyManagedRpcRestrictions(
    registrar: RestrictableRegistrar,
    allowed: readonly string[] = MANAGED_ALLOWED_RPCS,
): void {
    if (!registrar.setManagedAllowlist) {
        throw new Error('managed restrictions require a dispatch-level allowlist');
    }
    registrar.setManagedAllowlist(allowed);
}
