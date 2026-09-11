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

import { buildManagedRuntimeStatus } from '@/managed/managedRuntimeStatus';
import type { ManagedFilesystemFacts } from '@/managed/managedRuntimeFacts';
import type { ManagedRestoreState } from '@/managed/managedRestoreState';
import {
    canonicalManagedPayloadDigest,
    verifyManagedDispatchToken,
    type ManagedOp,
    type ManagedRunTokenClaims,
    type ManagedRuntimeLeaseTokenClaims,
    type ManagedCheckpointTokenClaims,
    type ManagedCredentialTokenClaims,
    type ManagedStatusTokenClaims,
    type ManagedTokenFailure,
} from './managedDispatchToken';
import {
    classifyManagedReceipt,
    managedOperationKey,
    type ManagedReceipt,
    type ManagedReceiptStore,
} from './managedReceiptStore';
import {
    probeProcessGroup,
    type ProcessGroupDeps,
    type ProcessGroupEvidence,
} from './managedProcessGroup';
import type { ManagedRuntimeIdentity } from './managedRuntimeIdentity';
import { normalizeManagedCredentialParams, type ManagedCredentialEnvelope, type ManagedCredentialReplacement,
    type ManagedCredentialRelayOutcome } from './managedDaemonCredential';
import { logger } from '@/ui/logger';
import {
    ManagedSpawnEnvelopeError,
    parseManagedSpawnEnvelope,
    type ManagedSpawnEnvelope,
} from '@/managed/managedSpawnBootstrap';

/**
 * Every RPC a managed runtime serves. **One list**, and everything downstream
 * is derived from it: the registrations and the dispatch allowlist.
 *
 * There were two lists before, and they disagreed. `managed:checkpoint` and
 * `managed:credential` were registered here and missing from the allowlist, so
 * the dispatcher refused them as if they did not exist — a managed runtime
 * could not be handed a checkpoint target at all, and the failure named a
 * capability rather than the missing entry. `managed:status` and
 * `managed:runtime-lease` were the mirror image: allowed, and absent from this
 * one. Deriving both from here is what makes that class of gap unrepresentable.
 */
export const MANAGED_RPC_METHODS = [
    'managed:spawn', 'managed:stop', 'managed:receipt', 'managed:lease',
    'managed:status', 'managed:runtime-lease',
    /**
     * Takes a renewed credential for the Machine this runtime already is.
     *
     * The runtime cannot renew its own: both control-plane routes that issue a
     * daemon credential require the parent's signature, which no process here
     * holds. And the file it was delivered in is written once, at start — so
     * without this, a credential could only be replaced by recreating the
     * machine, and a runtime whose credential lapsed would simply stop.
     */
    'managed:credential',
    /**
     * Takes the destinations one checkpoint may be written to.
     *
     * The runtime cannot produce them: the URLs are presigned with the parent's
     * storage credentials and the authorisation is signed with a key no process
     * here holds. What arrives is bound to one checkpoint and to the exact
     * parameters it was signed for, so the same authorisation cannot be
     * replayed into another checkpoint's namespace or against other
     * destinations.
     */
    'managed:checkpoint',
] as const;

export type ManagedSpawnRequest = {
    directory: string;
    agent?: string;
    environmentVariables?: Record<string, string>;
    initialPrompt?: string;
    initialPromptLocalId?: string;
    /**
     * The rest of the bootstrap envelope, which arrives **flat** in this same
     * object: `model`, `effort`, `bootstrap`, `gateway`.
     *
     * Not nested under a field of its own, because the parent already signs
     * this shape — `buildManagedSpawnParams` returns exactly these keys at the
     * top level and the dispatcher forwards them unchanged. Introducing a
     * wrapper here would have rejected every real spawn while every test that
     * built its own request still passed.
     *
     * Left off this type on purpose: the fields are untrusted input and are
     * only ever read through `parseManagedSpawnEnvelope`, which is what gives
     * them a type. They carry a scoped bearer and the session's raw key, so
     * they are never logged, never put in an environment, and never echoed in
     * a failure.
     */
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
    /**
     * The envelope, validated here and **re-serialized from what was parsed**.
     *
     * The launcher parses it again on its own side — it does not trust this
     * process — and re-serializing the parsed value is what makes the two
     * parses see the same document: a field this runtime did not validate
     * cannot ride along inside the bytes that cross that boundary.
     */
    bootstrapEnvelope: Buffer;
    /** The same content, parsed. For routing decisions here; never logged. */
    envelope: ManagedSpawnEnvelope;
};

export type ManagedRuntimeFacts = {
    filesystem: ManagedFilesystemFacts;
    restore: ManagedRestoreState;
    isolation: { verified: boolean; backend: string };
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
    /**
     * What the runtime can say about itself, gathered from things it cannot
     * talk itself into: the kernel's mount view, the root-protected completion
     * record, and the isolation backend's own answer.
     *
     * Absent until the boot producer has run, and then a status read reports
     * what it found rather than guessing.
     */
    /**
     * Told when a verified renewal has moved this runtime's write deadline.
     *
     * The launcher holds the generations and enforces the lease against them;
     * this module holds the deadline. Without the call the two drift apart on
     * the first renewal, and what enforces the lease keeps using the deadline
     * the run started with.
     *
     * Called **after** the renewal is verified and persisted, never before: a
     * refused renewal must not move anything.
     */
    /**
     * Withdraws whatever a generation was allowed to do, when it is ending.
     *
     * Called on every path that ends one — the stop RPC, the fence a promotion
     * performs, the lease-expiry handler — and called **before** the stop is
     * requested, so a report already in flight cannot land after the child is
     * gone and re-register state for a generation that no longer exists.
     */
    onGenerationTerminated?: (input: { runId: string; attemptId: string; epoch: number }) => void;
    onLeaseRenewed?: (input: {
        epoch: number;
        /** Absent on a runtime-scoped lease, which is granted before any run. */
        runId?: string;
        attemptId?: string;
        leaseExpiresMonotonic: number;
        /**
         * The sequence this grant committed at. Absent when the grant carried
         * none, and then nothing may re-arm on its behalf.
         *
         * The supervisor refuses a renewal that does not advance it, so a
         * caller re-arming a generation has to carry the one that was written
         * rather than inventing a number.
         */
        renewalSeq?: number;
        /**
         * The parent's statement **exactly as it arrived**: the signed token and
         * the params it covers.
         *
         * Present on the runtime-scoped path only. Everything else this
         * callback receives is derived - numbers this daemon computed - and a
         * supervisor holding the marker and the verifier key cannot check a
         * number against a signature. Carried verbatim: a re-mint or a
         * re-serialisation here would make the daemon the issuer of the very
         * authority the supervisor is meant to be verifying.
         *
         * Absent on the run-scoped `managed:lease`, which is a different op
         * with a different claim shape and is unchanged by this increment.
         */
        grant?: { token: string; params: unknown };

    }) => void | Promise<{ enforced: boolean; detail?: string } | void>;
    /**
     * Called **after** the renewed lease is on disk, and only then.
     *
     * Anything that widens what this runtime may do — a report capability, a
     * longer admission — belongs here rather than in `onLeaseRenewed`: the
     * enforcement call has to happen before the write (so a renewal nobody
     * enforces is refused), and the write can still fail. A capability published
     * between the two outlives a record that was never written, which is the
     * runtime granting itself something no store agrees to.
     */
    onLeaseCommitted?: (input: {
        epoch: number;
        runId?: string;
        attemptId?: string;
        leaseExpiresMonotonic: number;
    }) => void;
    /**
     * Puts a renewed bearer on the disk and starts using it.
     *
     * Injected rather than done here: this module decides *whether* the request
     * is well-formed and authorised, and the writing belongs to the daemon that
     * owns the credential file and the socket.
     *
     * `machineId` and `serverOrigin` travel with it so the runtime can compare
     * them against what it holds. They are signed into the token's payload
     * digest, so a mismatch is not a badly-shaped request — it is a credential
     * that was issued for somebody else.
     *
     * `original` preserves the dispatch token and params before normalization,
     * so the eventual privileged receiver can authenticate what was signed.
     */
    replaceCredential?: (replacement: ManagedCredentialReplacement, original: ManagedCredentialEnvelope)
        => Promise<ManagedCredentialRelayOutcome>;
    /**
     * Takes a checkpoint target the parent issued, for the checkpoint it names.
     *
     * Injected rather than acted on here: this module decides whether the
     * request is authorised and whether this runtime may still write, and what
     * to do with the destinations belongs to the checkpoint session that owns
     * the drain, the archive and the pointer.
     */
    acceptCheckpointTarget?: (target: Record<string, unknown>, dispatchToken: string) => Promise<{
        accepted: boolean;
        /**
         * What the inbox did with it, when it accepted.
         *
         * `queued` / `replaced-unconsumed` mean an archive follows from this
         * delivery. `in-flight` means that id is already running, and
         * `already-completed` means it published its pointer — both are
         * acceptances of the *hop* and neither produces an archive, which is
         * the distinction the parent needs and must never guess.
         */
        state?: string;
        /** A fixed classifier from the runtime. Never a URL and never the key. */
        detail: string;
    }>;
    runtimeFacts?: () => ManagedRuntimeFacts | Promise<ManagedRuntimeFacts>;
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
        }) => Promise<BackendStopResult>;
    };
};

/** Whether the trusted backend accepted the stop. `false` is never discarded. */
export type BackendStopResult = { requested: boolean; detail: string };

type RpcRegistrar = { registerHandler: (method: string, handler: (params: unknown) => unknown) => void };

/** Refusals the caller can act on, distinct from a crash. */
/**
 * Which launch stage refused, as a closed set.
 *
 * The launcher reports `stage` or `stage:detail`, and only the stage is a
 * reviewed value — the detail comes from the supervisor and can be anything.
 * Shape checks are not an allowlist: a lower-case 32-hex digest, or a bearer
 * that happens to be lower-case, passes any character-and-length test. So the
 * detail is dropped outright and an unrecognised stage becomes `unclassified`.
 * `WIRE_DIAGNOSTICS` is this set plus `envelope` and `unclassified`.
 */
const LAUNCH_STAGES = new Set([
    'launcher-unavailable',
    'launch-refused',
    'prepared-without-pid',
    'release-failed',
    'child-not-ready',
    'child-reported-another-session',
]);

/** The stage the launcher refused at, or `unclassified`. Never its detail. */
function launchRefusalStage(message: string): string {
    const stage = message.split(':', 1)[0]!;
    return LAUNCH_STAGES.has(stage) ? stage : 'unclassified';
}

/**
 * The diagnostics that may travel: the launch stages, plus the envelope
 * boundary and the fallback. Derived from `LAUNCH_STAGES` so the two cannot
 * drift — a stage that is not allowed on the wire would be a silent hole.
 */
const WIRE_DIAGNOSTICS = new Set([...LAUNCH_STAGES, 'envelope', 'unclassified']);

export class ManagedRpcError extends Error {
    /** Set only when it is one of `WIRE_DIAGNOSTICS`; otherwise dropped here. */
    readonly diagnostic?: string;

    constructor(readonly code: string, detail?: string, diagnostic?: string) {
        // The code leads so a caller can branch on it without parsing prose,
        // and the detail is only ever a short classifier — never provider text.
        super(detail ? `${code}: ${detail}` : code);
        this.name = 'ManagedRpcError';
        if (diagnostic !== undefined && WIRE_DIAGNOSTICS.has(diagnostic)) {
            this.diagnostic = diagnostic;
        }
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

    /**
     * The usable write deadline lives only in memory, on a monotonic clock. A
     * restart therefore starts expired and the runtime must obtain a freshly
     * signed lease before it may execute anything.
     */
    let leaseUntilMonotonic: number | null = null;

    const leaseValid = () => leaseUntilMonotonic !== null && runtime.monotonicNow() < leaseUntilMonotonic;

    /**
     * Moves this runtime's write deadline, and tells whoever is enforcing it.
     *
     * One function rather than two assignments, because the two have to happen
     * together: a renewal that updates the deadline here and not in the
     * launcher's registry leaves the generation being fenced against the
     * *previous* one — the parent believes it extended the lease, the runtime
     * agrees, and the thing that actually stops work does not.
     */
    /**
     * Extends the lease, and **only reports success if the extension is being
     * enforced**.
     *
     * The renewal has to reach the thing that stops work. It did not: the
     * supervisor arms a generation's watchdog with the deadline captured at
     * launch, and a renewal that moved this record and the report authority left
     * that watchdog alone — so a managed generation was killed at its original
     * deadline while the parent, the store and this runtime all agreed the lease
     * had been extended.
     *
     * So the consumer is **awaited**, and a consumer that says the extension is
     * not enforced makes this a refusal rather than a grant: a parent told "ok"
     * stops renewing, and the next thing that happens is a SIGKILL nobody
     * expected. Nothing is persisted and nothing is moved before the enforcement
     * answer, so a refusal leaves the previous lease exactly as it was.
     *
     * **An absent consumer is a refusal too.** Treating "nobody is wired" as
     * acceptance is precisely how broken wiring hides: the enforcement claim has
     * to come from something that enforces, and a host with nothing to re-arm
     * says so by answering `{ enforced: true }` rather than by being silent.
     */
    const enforceLeaseUntil = async (
        grantedMs: number,
        claims: { epoch: number; runId?: string; attemptId?: string; renewalSeq?: number },
        /** The runtime-scoped path's verbatim envelope; see `onLeaseRenewed`. */
        grant?: { token: string; params: unknown },
    ): Promise<number> => {
        /*
         * 이미 들어온 spawn 이 아직 등록되지 않았을 수 있다. 그 세대는 **옛**
         * deadline 으로 등록되고, 이 갱신의 snapshot 에는 없으므로 아무도 다시
         * 재무장하지 않는다. 그래서 기다리지 않고 거절한다 — 부모는 재시도한다.
         */
        if (spawnsInFlight > 0) throw new ManagedRpcError('renewal-race', 'spawn in flight');
        const leaseExpiresMonotonic = runtime.monotonicNow() + grantedMs;
        let outcome: { enforced: boolean; detail?: string } | void;
        renewalEnforcing = true;
        try {
            outcome = await runtime.onLeaseRenewed?.({
            epoch: claims.epoch,
            leaseExpiresMonotonic,
            // The sequence this grant committed at, so a consumer re-arming
            // a generation carries the written one rather than inventing it.
            ...(claims.renewalSeq === undefined ? {} : { renewalSeq: claims.renewalSeq }),
            /*
             * Present only on the run-scoped renewal. The runtime-scoped one is
             * granted before any run exists, and it moves the deadline for
             * **every** generation on this runtime rather than for one — a
             * consumer that keyed it to a run would be inventing the run.
             */
            ...(claims.runId ? { runId: claims.runId } : {}),
            ...(claims.attemptId ? { attemptId: claims.attemptId } : {}),
            ...(grant ? { grant } : {}),
            });
        } catch {
            // 이유는 소비자의 것이고 경로를 담을 수 있다. 집행되지 않았다는
            // 사실만으로 거절한다.
            throw new ManagedRpcError('renewal-not-enforced');
        } finally {
            renewalEnforcing = false;
        }
        /*
         * `void` 도 수락이 아니다.
         *
         * 예전에는 반환값 없는 소비자를 성공으로 봤고, 그것이 **배선이 끊긴 것을
         * 가리는** 정확한 방법이었다 — production 은 콜백을 반드시 꽂고, 꽂히지
         * 않았거나 아무 답도 하지 않는다면 그 갱신은 집행된 적이 없다.
         */
        if (!outcome || outcome.enforced !== true) {
            throw new ManagedRpcError(
                'renewal-not-enforced',
                // 소비자가 준 고정 코드만. 없으면 아무것도 싣지 않는다.
                outcome?.detail,
            );
        }
        /*
         * 후보 값을 **돌려주기만** 한다. 이 runtime 의 권한을 여기서 늘리면,
         * 뒤따르는 store 쓰기가 실패했을 때 기록은 옛 deadline 인데 이 프로세스는
         * 연장된 것으로 행동한다 — Astra 가 그것을 재현했다(persist throw 뒤에도
         * `isLeaseValid` 가 옛 deadline 을 넘겨 true).
         */
        return leaseExpiresMonotonic;
    };

    /**
     * Tells whoever widens capabilities that the record is on disk.
     *
     * Never throws: the lease **is** persisted by the time this runs, so a
     * consumer that fails here must not turn a committed renewal into a refusal
     * the parent would retry against a store that already moved.
     */
    /**
     * Runs one lease grant as a window a spawn can wait behind.
     *
     * Opened before the enforcement call and closed after the record is written
     * (or after the failure), so a generation registered on the other side of it
     * carries the deadline that is being enforced rather than the one it
     * launched with.
     */
    const inRenewalWindow = async <T>(run: () => Promise<T>): Promise<T> => {
        let close!: () => void;
        renewalWindow = new Promise<void>((resolve) => { close = resolve; });
        try {
            return await run();
        } finally {
            renewalWindow = null;
            close();
        }
    };

    const publishLeaseCommitted = (
        leaseExpiresMonotonic: number,
        claims: { epoch: number; runId?: string; attemptId?: string },
    ): void => {
        try {
            runtime.onLeaseCommitted?.({
                epoch: claims.epoch,
                leaseExpiresMonotonic,
                ...(claims.runId ? { runId: claims.runId } : {}),
                ...(claims.attemptId ? { attemptId: claims.attemptId } : {}),
            });
        } catch {
            logger.debug('[managed] lease committed hook failed');
        }
    };

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

    /**
     * The two axes the verifier cannot check for us.
     *
     * Audience and workspace are bound inside the token; project and key id are
     * this runtime's trusted identity, read from the protected marker. A token
     * minted for a sibling project — or by a key this runtime does not know —
     * verifies perfectly and still belongs to something else.
     *
     * Shared by both entry points on purpose. The provisioning-scoped path
     * used to omit them, so the same signer could take a `runtime-lease` for
     * one project and have it accepted by another runtime in the same
     * workspace: two implementations of one check are two checks that can
     * disagree, and this pair already had.
     */
    const assertRuntimeIdentityClaims = (claims: { projectId: string; kid: string }): void => {
        if (claims.projectId !== runtime.identity.projectId) {
            throw new ManagedRpcError('token-wrong-project');
        }
        if (claims.kid !== runtime.identity.keyId) {
            throw new ManagedRpcError('token-unknown-key');
        }
    };

    /**
     * Verifies a token for an operation that acts on a run.
     *
     * The return type is the run-scoped half of the claim union, so a caller
     * reading `runId` cannot be handed a status token — the separation the
     * token format enforces on the wire is the same one the type enforces
     * here, rather than something each call site has to remember.
     */
    const verify = (op: ManagedRunTokenClaims['op'], params: unknown): ManagedRunTokenClaims => {
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
            provisioningOperationId: runtime.identity.provisioningOperationId,
            now: runtime.now(),
        });
        if (!result.ok) throw new ManagedRpcError(`token-${result.reason}`);
        if (result.claims.op === 'status' || result.claims.op === 'runtime-lease'
            || result.claims.op === 'checkpoint' || result.claims.op === 'credential') {
            // Unreachable while `op` is run-scoped — the verifier already
            // refuses a mismatched op — and stated rather than cast away.
            throw new ManagedRpcError('token-wrong-op');
        }
        assertRuntimeIdentityClaims(result.claims);
        return result.claims;
    };


    /**
     * One serial section for renewal, epoch promotion and expiry handling.
     *
     * They all decide what this runtime may write, so interleaving them lets an
     * expiry that started before a renewal stop a child the renewal has just
     * made legitimate again. `pendingLeaseWork` is the count of operations that
     * have entered or are queued for the section, so teardown can wait for all
     * of them rather than only the most recent.
     */
    let leaseChain: Promise<unknown> = Promise.resolve();
    let transitioning = false;
    /** True while expired work is being handed to the backend. */
    let expiryHandling = false;
    let pendingLeaseWork = 0;
    /**
     * Spawns between admission and the launcher returning. This window is what
     * an epoch promotion must not cut across, so it is deliberately narrower
     * than the whole RPC.
     */
    let spawnsInFlight = 0;
    /**
     * A renewal is between "the enforcer was told" and "the record was written".
     *
     * Spawns are refused in that window, and a renewal is refused while a spawn
     * is in it: a generation registered while the enforcer's snapshot was already
     * taken carries the **old** deadline and nothing renews it before the parent
     * is told `ok`. Astra measured that — a newcomer left at 70_000 while the
     * renewal reported 100_000.
     *
     * Both directions refuse rather than wait. Waiting would mean two paths
     * holding each other under the same admission, and a retryable refusal is
     * what the parent already knows how to handle.
     */
    let renewalEnforcing = false;
    /**
     * Settles when the renewal window closes — after the record is written, or
     * after the renewal failed.
     *
     * A spawn that arrives inside the window **waits** for it rather than being
     * refused: the window is one enforcement call plus one store write, and on
     * the other side of it the generation is registered with the deadline that
     * is actually being enforced. Waiting cannot deadlock, because a renewal
     * never waits for a spawn — it refuses while one is mid-registration, and a
     * waiting spawn has not begun registering yet.
     */
    let renewalWindow: Promise<void> | null = null;
    /**
     * Whole RPCs — spawn *and* explicit stop — including the bookkeeping and
     * backend handover that follows. Teardown waits on these: `spawnsInFlight`
     * alone would let the writer lock go while a handover was still running,
     * and a stop RPC has no launcher window to be counted by at all.
     */
    const activeRpcs = new Set<Promise<unknown>>();

    /**
     * Set when shutdown begins. Refusing new *entries* is a different thing
     * from revoking *store writes*: work that is already inside must still be
     * able to record what it did, or a launch that succeeded is left looking
     * like it never finished.
     */
    let entriesClosed = false;

    const assertEntryOpen = () => {
        if (entriesClosed) throw new ManagedRpcError('shutting-down');
    };

    /** Tracks an RPC end to end so teardown can wait for it. */
    const trackRpc = <T>(work: Promise<T>): Promise<T> => {
        activeRpcs.add(work);
        return work.finally(() => { activeRpcs.delete(work); });
    };

    const serializeLease = <T>(work: () => Promise<T>): Promise<T> => {
        pendingLeaseWork += 1;
        const next = leaseChain.then(work, work).finally(() => { pendingLeaseWork -= 1; });
        leaseChain = next.then(() => undefined, () => undefined);
        return next;
    };

    const NO_BACKEND: BackendStopResult = { requested: false, detail: 'no-launch-backend' };

    /**
     * States that carry evidence nothing is running any more.
     *
     * `stopping` is not one of them: a stop was requested, which is not the
     * same as a stop having happened, and treating it as terminal is how an
     * obligation quietly disappears.
     */
    const isTrustedTerminal = (receipt: ManagedReceipt): boolean => (
        receipt.state === 'stopped'
        || receipt.state === 'tombstone'
        || (receipt.state === 'failed' && receipt.failureReason === 'not-started')
    );

    /**
     * Asks the trusted backend to stop one attempt, and observes locally.
     *
     * The request is always made — a receipt with no pgid is a `spawning` row
     * that may have a live child nobody wrote down, and an `EPERM` probe means
     * the group is alive under another uid. Skipping either is how a child
     * outlives its Run.
     *
     * This process never signals the group itself. A persisted pid is a number
     * the kernel may have handed to something else since, so it is evidence
     * about what is visible, never authority to kill.
     */
    const stopAttempt = async (receipt: ManagedReceipt): Promise<{
        evidence: ProcessGroupEvidence;
        backendStop: BackendStopResult;
    }> => {
        const evidence = receipt.pgid === null
            ? { kind: 'no-local-trace' as const }
            : probeProcessGroup(receipt.pgid, runtime.processGroupDeps);
        /*
         * The generation's authority is withdrawn **before** the stop is asked
         * for, and on every path that asks — the explicit stop, the epoch
         * promotion's fence, and the lease-expiry handler all come through
         * here.
         *
         * Before, because a request that was authorised a moment ago can still
         * be in flight: a report accepted after the child is gone re-registers
         * state for a generation that no longer exists, and nothing later
         * removes it. Withdrawing first makes the window closed rather than
         * short.
         *
         * Doing it here rather than at each call site is the point. The
         * previous arrangement discarded only on the session paths, so the two
         * that actually end a generation — the stop RPC and the watchdog —
         * left the capability standing.
         */
        runtime.onGenerationTerminated?.({
            runId: receipt.runId,
            attemptId: receipt.attemptId,
            epoch: receipt.epoch,
        });
        if (!runtime.fencingBackend) return { evidence, backendStop: NO_BACKEND };
        const backendStop = await runtime.fencingBackend.requestStop({
            runId: receipt.runId,
            attemptId: receipt.attemptId,
            epoch: receipt.epoch,
            pgid: receipt.pgid,
        });
        return { evidence, backendStop };
    };

    /**
     * Accepts a request at most once. A retry of the same attempt returns the
     * existing receipt without starting anything; an intentional new attempt
     * arrives under a different operation key.
     */
    const spawnRpc = async (params: unknown) => {
            assertEntryOpen();
            const claims = verify('spawn', params);
            if (!leaseValid()) throw new ManagedRpcError('lease-expired');
            // An epoch transition is in progress; starting work now would race
            // the fence it is trying to establish.
            if (transitioning || expiryHandling) {
                throw new ManagedRpcError('epoch-transition-in-progress');
            }

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
                return {
                    accepted: true,
                    receipt: receiptView(receipt, runtime),
                    stopIntentRecorded: receipt.stopRequestedAt !== null,
                    backendStop: null as BackendStopResult | null,
                    terminationProven: false,
                };
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

            /*
             * 갱신이 집행과 기록 사이에 있으면 **여기서 기다린다** — lease 를 읽기
             * 전이다.
             *
             * 창 안에서 등록되면 그 세대는 옛 deadline 을 들고 시작하고 이 갱신의
             * snapshot 밖이라 아무도 다시 재무장하지 않는다. 거절해도 창은 닫히지만,
             * 기다리는 편이 낫다: 창은 집행 한 번 + 기록 한 번이고 그 뒤에는 실제로
             * 집행되는 deadline 으로 등록된다. 교착은 없다 — 갱신은 spawn 을
             * 기다리지 않고(등록 중이면 거절), 여기서 기다리는 spawn 은 아직 등록을
             * 시작하지 않았다.
             */
            if (renewalWindow) await renewalWindow;

            // Re-checked here because a fence may have begun while this request
            // was between admission and the launcher.
            if (transitioning || expiryHandling || !leaseValid()) {
                throw new ManagedRpcError('epoch-transition-in-progress');
            }

            /*
             * The envelope is validated **before** anything is launched, and
             * the failure says which field was wrong and nothing about its
             * value: this document holds a bearer and a session key.
             *
             * A refusal here leaves the receipt in `spawning`, which is the
             * honest state — the request was accepted and no child was started,
             * so a reconciliation pass decides what happened rather than this
             * path guessing.
             */
            let envelope: ManagedSpawnEnvelope;
            try {
                // The request **is** the envelope: the parent's signed wire.
                envelope = parseManagedSpawnEnvelope(request, runtime.now());
            } catch (error) {
                const field = error instanceof ManagedSpawnEnvelopeError ? error.field : 'envelope';
                runtime.store.update(key, {
                    state: 'failed', failureReason: 'not-started',
                }, runtime.now());
                throw new ManagedRpcError('spawn-rejected', `envelope: ${field}`, 'envelope');
            }

            // Everything the launcher is told comes from the verified token.
            const context: ManagedSpawnContext = {
                operationKey: key,
                // Only what parsed: see the field's own note.
                bootstrapEnvelope: Buffer.from(JSON.stringify(envelope), 'utf8'),
                envelope,
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
                    /*
                     * **stage 하나만** 남긴다 — 전선에도, 이 Error 에도, 로그
                     * 에도. supervisor detail 은 검토된 값이 아니라 경로나
                     * 자격을 담을 수 있고, 모양이 멀쩡하다고 안전한 것이 아니다.
                     */
                    const stage = launchRefusalStage(outcome.errorMessage);
                    logger.debug(`[managed] spawn refused at ${stage}`);
                    throw new ManagedRpcError('spawn-rejected', stage, stage);
                }
                throw new ManagedRpcError('reconciliation-required', 'spawn outcome unknown');
            }

            // The child is detached, so it leads its own process group. The pid
            // is recorded for observation only; stopping it belongs to the
            // trusted backend.
            const after = runtime.store.update(key, {
                state: 'running',
                pid: outcome.pid,
                pgid: outcome.pid,
                sessionId: outcome.sessionId,
            }, runtime.now());

            // A stop that arrived while the spawn was in flight is honoured now
            // that there is something to signal.
            if (after.stopRequestedAt !== null) {
                const { evidence, backendStop } = await stopAttempt(after);
                const stopped = runtime.store.update(key, { state: 'stopping' }, runtime.now());
                // `accepted` describes this spawn: the request was admitted and
                // a child was started. A backend that could not take the stop
                // does not turn that into a rejection — the run exists and the
                // caller must not read it as never-started.
                return {
                    accepted: true,
                    receipt: receiptView(stopped, runtime),
                    stopIntentRecorded: true,
                    backendStop: backendStop as BackendStopResult | null,
                    terminationProven: false,
                    localEvidence: evidence,
                };
            }
            // Uniform shape: a caller must not have to branch on field presence
            // to learn whether a stop was involved.
            return {
                accepted: true,
                receipt: receiptView(after, runtime),
                stopIntentRecorded: false,
                backendStop: null as BackendStopResult | null,
                terminationProven: false,
            };
    };

    /**
     * Accepts a stop. The answer reports the durable intent, whether the
     * backend took the handover, and that termination is unproven — it never
     * asserts that the session ended, because a child that called `setsid` is
     * invisible to every check available here.
     */
    const stopRpc = async (params: unknown) => {
            assertEntryOpen();
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
                // Nothing was ever started, so there is nothing to terminate.
                return {
                    stopIntentRecorded: true,
                    backendStop: { requested: true, detail: 'never-dispatched' },
                    terminationProven: true,
                    receipt: receiptView(tomb.receipt, runtime),
                };
            }

            const receipt = existing.receipt;
            if (receipt.state === 'spawning') {
                // No pid yet. The spawn path consumes this flag once it has one,
                // but a persisted `spawning` row from a previous process may
                // already have a live child, so the backend is asked as well.
                const marked = runtime.store.update(key, { stopRequestedAt: runtime.now() }, runtime.now());
                const { evidence, backendStop } = await stopAttempt(marked);
                return {
                    stopIntentRecorded: true,
                    backendStop,
                    terminationProven: false,
                    receipt: receiptView(marked, runtime),
                    localEvidence: evidence,
                };
            }
            if (receipt.state === 'stopped' || receipt.state === 'tombstone'
                || (receipt.state === 'failed' && receipt.failureReason === 'not-started')) {
                // Terminal with evidence that nothing is running: there is
                // nothing for the backend to stop.
                return {
                    stopIntentRecorded: true,
                    backendStop: { requested: true, detail: 'already-terminal' },
                    terminationProven: true,
                    receipt: receiptView(receipt, runtime),
                };
            }

            const marked = runtime.store.update(key, {
                state: 'stopping', stopRequestedAt: runtime.now(),
            }, runtime.now());
            const { evidence, backendStop } = await stopAttempt(marked);
            // Three separate facts, never collapsed:
            //   stopIntentRecorded — the receipt durably says "stop this"
            //   backendStop        — whether the launcher took the request
            //   terminationProven  — whether anything actually ended
            // Only cgroup emptiness or a provider stop can set the last one, so
            // it is false here regardless of what the local probe saw.
            return {
                stopIntentRecorded: true,
                backendStop,
                terminationProven: false,
                receipt: receiptView(marked, runtime),
                localEvidence: evidence,
            };
    };


    /**
     * Verifies a token bound to the provisioning operation rather than to a
     * run. Returns the provisioning half of the claim union, so a caller
     * reading `provisioningOperationId` cannot be handed a work token.
     */
    const verifyProvisioning = (
        op: 'status' | 'runtime-lease' | 'credential' | 'checkpoint',
        params: unknown,
    ): ManagedStatusTokenClaims | ManagedRuntimeLeaseTokenClaims | ManagedCredentialTokenClaims
    | ManagedCheckpointTokenClaims => {
        if (!params || typeof params !== 'object' || Array.isArray(params)) {
            throw new ManagedRpcError('malformed-request');
        }
        const record = params as Record<string, unknown>;
        const token = record.token;
        if (typeof token !== 'string') throw new ManagedRpcError('malformed-request');
        const result = verifyManagedDispatchToken({
            token,
            verifier: runtime.identity.verifier,
            runtimeId: runtime.identity.runtimeId,
            workspaceId: runtime.identity.workspaceId,
            op,
            paramsDigest: canonicalManagedPayloadDigest(record.params ?? {}),
            currentEpoch: storedLease().epoch,
            provisioningOperationId: runtime.identity.provisioningOperationId,
            now: runtime.now(),
        });
        if (!result.ok) throw new ManagedRpcError(`token-${result.reason}`);
        if (result.claims.op !== op) throw new ManagedRpcError('token-wrong-op');
        assertRuntimeIdentityClaims(result.claims);
        return result.claims;
    };

    /**
     * The one place a write lease is granted.
     *
     * Both lease operations reach it: the run-scoped `lease`, and the
     * `runtime-lease` a runtime is given before it has any run. They differ
     * only in what their claim is bound to — the serialization, the sequence
     * check and the fence that a promotion has to pass are the same code,
     * because two implementations of a fence are two fences that can disagree.
     */
    const applyLeaseClaims = (claims: {
        epoch: number;
        renewalSeq: number;
        leaseMs: number;
        absoluteExpiry: number;
        exp: number;
        /** Present on the run-scoped lease; a runtime lease has no run yet. */
        runId?: string;
        attemptId?: string;
        /**
         * The runtime-scoped path's verbatim `{token, params}`.
         *
         * Threaded rather than reconstructed: by the time execution reaches
         * here the claims are parsed numbers, and the signed document exists
         * only at the entry above.
         */
        grant?: { token: string; params: unknown };
    }) => {
            assertEntryOpen();
            // Renewal and epoch transition are serialized: two interleaved
            // renewals could otherwise commit out of order and walk the
            // sequence backwards, which is exactly what replay protection
            // depends on not happening.
            return serializeLease(async () => {
                // Re-checked inside the queue: an operation ahead of this one
                // may have taken long enough for this token to age out, and a
                // future `absoluteExpiry` is not a substitute for a live token.
                if (claims.exp <= runtime.now()) throw new ManagedRpcError('token-expired');
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
                        // Hand every prior-generation attempt to the backend,
                        // then let the backend say whether the generation is
                        // gone. The local probe is recorded alongside it, but
                        // it does not decide anything:
                        //
                        // a receipt keeps a numeric pgid, and the kernel may
                        // have since given that number to an unrelated process.
                        // Reading `alive` (or `EPERM`, which is the normal
                        // answer once agents run under their own uid) off such
                        // a number and refusing the promotion blocks the
                        // runtime forever on a coincidence, even when the
                        // authoritative backend has proven the generation
                        // stopped. Ownership is what makes an observation
                        // actionable, and this process has none here.
                        const evidence: ProcessGroupEvidence[] = [];
                        for (const receipt of live) evidence.push((await stopAttempt(receipt)).evidence);

                        const proof = await runtime.fencingBackend.proveGenerationStopped({
                            belowEpoch: claims.epoch,
                        });
                        if (!proof.proven) {
                            throw new ManagedRpcError('fence-proof-unavailable', proof.detail);
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
                        const grantedMs = clampLease(claims.leaseMs!, claims.absoluteExpiry!);
                        /*
                         * 집행 먼저, 기록은 그 다음이다. 순서를 바꾸면 집행이
                         * 거절된 뒤에도 store 는 연장된 lease 를 들고 있게 되고,
                         * 그 상태는 이 runtime 이 스스로에게 거짓말하는 것이다.
                         */
                        await inRenewalWindow(async () => {
                            const enforcedUntil = await enforceLeaseUntil(grantedMs, claims, claims.grant);
                            runtime.store.writeLease({
                                epoch: claims.epoch,
                                renewalSeq: claims.renewalSeq!,
                                updatedAt: runtime.now(),
                            });
                            // 기록이 남은 뒤에 이 프로세스의 권한을 움직인다.
                            leaseUntilMonotonic = enforcedUntil;
                            publishLeaseCommitted(enforcedUntil, claims);
                        });
                        return {
                            ok: true,
                            epoch: claims.epoch,
                            renewalSeq: claims.renewalSeq,
                            grantedMs,
                            fenced: true,
                            localEvidence: evidence,
                            // The ceiling this grant was actually clamped by.
                            // Without it the parent knows only what it asked
                            // for, and publishing a deadline from the request
                            // rather than from the grant is how a lease outlives
                            // what this runtime agreed to.
                            absoluteExpiry: claims.absoluteExpiry,
                        };
                    } finally {
                        transitioning = false;
                    }
                }

                const grantedMs = clampLease(claims.leaseMs!, claims.absoluteExpiry!);
                // 집행 먼저. 거절이면 아무것도 기록하지 않고 ACK 도 하지 않는다.
                await inRenewalWindow(async () => {
                    const enforcedUntil = await enforceLeaseUntil(grantedMs, claims, claims.grant);
                    runtime.store.writeLease({
                        epoch: claims.epoch,
                        renewalSeq: claims.renewalSeq!,
                        updatedAt: runtime.now(),
                    });
                    leaseUntilMonotonic = enforcedUntil;
                    publishLeaseCommitted(enforcedUntil, claims);
                });
                return {
                    ok: true,
                    epoch: claims.epoch,
                    renewalSeq: claims.renewalSeq,
                    grantedMs,
                    fenced: false,
                    localEvidence: [] as ProcessGroupEvidence[],
                    // Same reason as the promotion path: the parent must read
                    // the ceiling that was applied, not the one it sent.
                    absoluteExpiry: claims.absoluteExpiry,
                };
            });
    };

const checkpointRpc = async (params: unknown) => {
        // The same two gates every other entry has, and for the same reasons:
        // a target accepted after teardown has closed entries is a write set up
        // while the runtime believes nothing is running, and an untracked one
        // lets teardown finish while it is still being handed over.
        assertEntryOpen();
        const claims = verifyProvisioning('checkpoint', params) as ManagedCheckpointTokenClaims;
        /*
         * A checkpoint is a write, and it ends by publishing a pointer other
         * runtimes read. Without a live lease the archive is a picture of a
         * volume this runtime may no longer hold — and the pointer would then
         * announce it as the latest.
         */
        if (!leaseValid()) throw new ManagedRpcError('lease-expired');
        if (!runtime.acceptCheckpointTarget) {
            // Reported rather than ignored: a parent that believes it issued a
            // target and did not is a parent whose checkpoints never happen and
            // whose runtime says nothing about it.
            throw new ManagedRpcError('capability-unavailable');
        }
        const record = (params && typeof params === 'object' && !Array.isArray(params))
            ? (params as Record<string, unknown>).params
            : null;
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw new ManagedRpcError('malformed-request');
        }
        const target = record as Record<string, unknown>;
        /*
         * The token names the checkpoint; the parameters carry it too, and they
         * must be the same one. Otherwise a target for one checkpoint is
         * accepted under another's authorisation, and what gets written is not
         * the namespace the parent named.
         */
        if (target.checkpointId !== claims.checkpointId) {
            throw new ManagedRpcError('token-payload-mismatch');
        }
        /*
         * The token as it arrived, beside the params it signed.
         *
         * This daemon's verification above authorises *this* hop and nothing
         * further: the supervisor is another process, holds the root-owned
         * marker and the verifier key, and has no way to establish that the
         * parent issued this document unless the signature travels with it. It
         * is passed unaltered - a re-mint here would make the daemon the issuer
         * of the authority the supervisor is supposed to be checking.
         */
        const dispatchToken = (params as Record<string, unknown>).token as string;
        const outcome = await runtime.acceptCheckpointTarget(target, dispatchToken);
        if (!outcome.accepted) {
            /*
             * The runtime that holds the checkpoint session is another process
             * and it can say no. Reporting an acceptance anyway tells the parent
             * a credential it issued is in place — and that credential then
             * expires where nobody is looking.
             *
             * The code is fixed; the runtime's own detail stays local, because
             * what did not fit here is a target full of signed URLs.
             */
            logger.debug(`[managed] checkpoint target not accepted (${outcome.detail})`);
            throw new ManagedRpcError('checkpoint-target-refused');
        }
        /*
         * 받아들인 것과 아카이브가 도는 것은 다른 사실이고, 응답은 둘 다
         * 말한다: 여기까지 왔으면 문서는 도착했고(수락), `state` 가 이 전달로
         * 아카이브가 따라오는지를 말한다. 상태를 말하지 않는 runtime 은 그
         * 사실을 지운 것이므로 답으로 읽지 않는다.
         */
        if (typeof outcome.state !== 'string' || outcome.state.trim() === '') {
            throw new ManagedRpcError('malformed-request');
        }
        return { accepted: true, checkpointId: claims.checkpointId, state: outcome.state };
    };

const credentialRpc = async (params: unknown) => {
        // The same two gates every other entry has: refused once teardown
        // has closed entries, and tracked so teardown waits for a write
        // that is already in flight. Without them a credential could be
        // written while the runtime believed nothing was running.
        assertEntryOpen();
        verifyProvisioning('credential', params);
        if (!runtime.replaceCredential) {
            // Nothing wired to accept it. Reported rather than ignored: a
            // parent that believes it renewed and did not is a parent that
            // stops trying.
            throw new ManagedRpcError('capability-unavailable');
        }
        // verifyProvisioning authenticated this envelope. Keep its original params,
        // including signed unknown fields, separate from the normalized replacement.
        const record = params as Record<string, unknown>;
        const token = record.token;
        if (typeof token !== 'string') throw new ManagedRpcError('malformed-request');
        const original: ManagedCredentialEnvelope = { token, params: record.params };
        const normalized = normalizeManagedCredentialParams(original.params, () => runtime.now());
        if (!normalized.ok) throw new ManagedRpcError(normalized.reason);
        const outcome = await runtime.replaceCredential(normalized.replacement, original);
        if (!outcome.ok) throw new ManagedRpcError(outcome.reason);
        // The expiry that is now **on the disk**, from the writer rather than
        // from the request: the parent must see which renewal actually took.
        return { accepted: true, expiresAt: outcome.expiresAt };
    };

    return {
        /**
         * Reports what this runtime is, and what it currently holds.
         *
         * A reading. It renews nothing and advances nothing — the parent polls
         * it, including while a runtime is expired, and a reading that renewed
         * would make asking the way to stay alive.
         */
        /**
         * Replaces the bearer this runtime authenticates with.
         *
         * Three things it refuses, and each is a way the identity could be
         * moved rather than renewed:
         *
         *  - a credential for **another Machine**. The marker says which one
         *    this is; a replacement naming a different one would make this
         *    runtime publish readiness where nobody is watching.
         *  - one that does not **outlive** what is stored. A replay of an
         *    earlier renewal would walk the credential backwards, and the
         *    window it shortens is the one the runtime is living in.
         *  - one for a **different server**. The bearer is only meaningful to
         *    the origin that issued it, and sending it elsewhere is sending a
         *    credential to a stranger.
         *
         * Key material is not part of this. A renewal extends a bearer; the
         * machine key is write-once and stays exactly as it was.
         */
        credential: (params: unknown) => trackRpc(credentialRpc(params)),

        /**
         * Takes the destinations one checkpoint may be written to.
         *
         * Tracked like every other write entry, so teardown waits for a
         * hand-over already in flight rather than finishing beside it.
         */
        checkpoint: (params: unknown) => trackRpc(checkpointRpc(params)),

        /**
         * The push itself. Kept separate so the exported entry can be tracked
         * end to end, the way `spawn` and `stop` are.
         */
        status: async (params: unknown) => {
            verifyProvisioning('status', params);
            const facts = await runtime.runtimeFacts?.() ?? {
                // Before the boot producer has run there is nothing to report
                // but the absence of it, and absence is not readiness.
                filesystem: { ok: false as const, reason: 'root-not-mounted' as const },
                restore: { status: 'pending' as const, checkpointId: null, manifestDigest: null },
                isolation: { verified: false, backend: runtime.identity.isolation.backend },
            };
            // Reuse status's existing policy (including its epoch exemption).
            // Waiting for live evidence must not extend token validity.
            verifyProvisioning('status', params);
            const stored = storedLease();
            return buildManagedRuntimeStatus({
                identity: runtime.identity,
                lease: {
                    epoch: stored.epoch,
                    renewalSeq: stored.renewalSeq,
                    // Read, never extended.
                    remainingMs: leaseUntilMonotonic === null
                        ? 0
                        : leaseUntilMonotonic - runtime.monotonicNow(),
                },
                filesystem: facts.filesystem,
                restore: facts.restore,
                isolation: facts.isolation,
            });
        },

        /**
         * Grants this runtime a lease before it has any run.
         *
         * The same serialized fencing path the run-scoped lease takes — a
         * promotion still has to prove the previous generation is gone. Only
         * what the claim is bound to differs.
         */
        'runtime-lease': async (params: unknown) => {
            const claims = verifyProvisioning('runtime-lease', params);
            if (claims.op !== 'runtime-lease') throw new ManagedRpcError('token-wrong-op');
            /*
             * The document as it arrived, kept alive across the layers below.
             * `verifyProvisioning` has already read the same two fields to
             * check them; this carries them rather than re-deriving anything.
             */
            const record = params as Record<string, unknown>;
            return applyLeaseClaims({
                epoch: claims.epoch,
                renewalSeq: claims.renewalSeq,
                leaseMs: claims.leaseMs,
                absoluteExpiry: claims.absoluteExpiry,
                exp: claims.exp,
                grant: { token: record.token as string, params: record.params ?? {} },
            });
        },

        /** Tracked end to end so teardown waits for post-launch work too. */
        spawn(params: unknown) {
            return trackRpc(spawnRpc(params));
        },

        /**
         * Refuses further RPC entries. Store writes stay open so that work
         * already inside can finish; teardown revokes those separately once
         * `drainLeaseWork` reports everything settled.
         */
        closeEntries(): void {
            entriesClosed = true;
        },

        stop(params: unknown) {
            return trackRpc(stopRpc(params));
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
            return applyLeaseClaims({
                epoch: claims.epoch,
                renewalSeq: claims.renewalSeq,
                leaseMs: claims.leaseMs,
                absoluteExpiry: claims.absoluteExpiry,
                exp: claims.exp,
                // The generation this renewal is for. The runtime-scoped lease
                // above has none — it is granted before any run exists.
                runId: claims.runId,
                attemptId: claims.attemptId,
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
        async runLeaseMaintenance() {
            return serializeLease(async () => {
            // One listing for the whole tick. Reading it twice would let the
            // two passes disagree, and reading only `receipts` would hide an
            // entry we could not parse — which may be exactly the pending stop
            // this pass exists to retry.
            const listing = runtime.store.list();
            const storeUnreadable = listing.unknown.length > 0 || listing.listError !== undefined;

            // A stop that was already decided is an obligation of its own. It
            // must be retried whether or not the lease is currently valid —
            // tying the retry to expiry means a stream of renewals can keep a
            // refused handover pending forever.
            const pendingStops = listing.receipts.filter((receipt) => (
                receipt.stopRequestedAt !== null && !isTrustedTerminal(receipt)
            ));
            const stillPending: string[] = [];
            /** Attempts already handed over in this tick, so neither pass repeats one. */
            const handedOver = new Set<string>();
            for (const receipt of pendingStops) {
                const { backendStop } = await stopAttempt(receipt);
                handedOver.add(receipt.requestKey);
                if (!backendStop.requested) stillPending.push(receipt.requestKey);
            }
            const pendingStopsRetried = pendingStops.length;

            // Re-read inside the section: a renewal queued ahead of this call
            // may have made the lease valid again, and stopping a child now
            // would kill work the server has just re-authorised.
            if (leaseValid()) {
                return {
                    expired: false,
                    launching: false,
                    // An obligation nobody accepted is still outstanding even
                    // while the runtime is allowed to work, and a store we
                    // could not read may hold one we never saw.
                    actionRequired: stillPending.length > 0 || storeUnreadable,
                    storeUnreadable,
                    live: [] as string[],
                    unstoppable: stillPending,
                    pendingStopsRetried,
                };
            }
            expiryHandling = true;
            try {
            // A receipt without a pgid is included on purpose: `spawning` means
            // a child may exist whose pid was never recorded, and skipping it
            // would leave exactly the case nobody can see.
            const live = listing.receipts.filter((receipt) => (
                receipt.state === 'spawning' || receipt.state === 'spawned'
                || receipt.state === 'running' || receipt.state === 'stopping'
            ));

            const handled: string[] = [];
            const unstoppable: string[] = [...stillPending];
            for (const receipt of live) {
                if (handedOver.has(receipt.requestKey)) {
                    // Already handed over by the pending pass in this tick.
                    handled.push(receipt.requestKey);
                    continue;
                }
                // Written before the handover so the intent survives a restart
                // in the middle of it. It is also what a spawn that is still
                // launching reads when it finishes, so a child that arrives
                // after its lease expired stops itself.
                const marked = receipt.stopRequestedAt === null
                    ? runtime.store.update(
                        receipt.requestKey, { stopRequestedAt: runtime.now() }, runtime.now(),
                    )
                    : receipt;
                const { backendStop } = await stopAttempt(marked);
                if (!backendStop.requested) unstoppable.push(marked.requestKey);
                handled.push(marked.requestKey);
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
            // A proof taken now says nothing about a child that has not been
            // created yet, so an outstanding launch keeps this unresolved.
            const launching = spawnsInFlight > 0;
            return {
                expired: true,
                launching,
                pendingStopsRetried,
                actionRequired: launching || storeUnreadable || unstoppable.length > 0
                    || (live.length > 0 && !proven),
                storeUnreadable,
                live: handled,
                unstoppable,
            };
            } finally {
                expiryHandling = false;
            }
            });
        },

        /**
         * Resolves once every queued or running lease operation has finished.
         * Teardown uses this so a stop or fence in progress cannot outlive the
         * writer lock it is holding.
         */
        async drainLeaseWork(): Promise<void> {
            // Spawn RPCs are drained too, in full: anything still running when
            // the writer lock is released would write into a store another
            // daemon may already own.
            while (pendingLeaseWork > 0 || activeRpcs.size > 0) {
                await Promise.allSettled([leaseChain, ...activeRpcs]);
            }
        },

        /** Exposed for wiring tests: is the runtime currently allowed to work? */
        isLeaseValid: leaseValid,
        probeGroup: (pgid: number) => probeProcessGroup(pgid, runtime.processGroupDeps),
    };
}

export type ManagedRpcHandlers = ReturnType<typeof createManagedRpcHandlers>;

/**
 * Refusal codes a caller may branch on. An allowlist, not a passthrough: an
 * unrecognised code reaches the wire without a `code` field so a typo here can
 * never be mistaken for a contract the server can act on.
 *
 * `token-*` mirrors `ManagedTokenFailure`, which `verify` prefixes.
 */
/**
 * Every `ManagedTokenFailure`, as the code the wire carries.
 *
 * A `Record` keyed by the union rather than a hand-written list, so a new
 * failure reason **fails the build** until it is classified. Hand-written was
 * how `token-wrong-operation` came to be missing: `verify` returned it, the
 * allowlist did not carry it, and a validly signed token minted for another
 * provisioning operation came back as `managed-unknown-failure` — a caller
 * cannot act on that, and it reads like a crash rather than the closed refusal
 * it is. Deliberately not a `token-*` wildcard: a wildcard would admit whatever
 * a future prefix produces, which is the property this set exists to deny.
 */
const TOKEN_REFUSAL_REASONS: Record<ManagedTokenFailure, true> = {
    malformed: true,
    'bad-signature': true,
    'wrong-audience': true,
    'wrong-workspace': true,
    'wrong-op': true,
    'wrong-operation': true,
    expired: true,
    'clock-skew': true,
    'ttl-too-long': true,
    'stale-epoch': true,
    'epoch-mismatch': true,
    'payload-mismatch': true,
};

/** `wrong-operation` → `token-wrong-operation`, the shape `verify` is prefixed into. */
const TOKEN_REFUSAL_CODES: readonly string[] =
    Object.keys(TOKEN_REFUSAL_REASONS).map((reason) => `token-${reason}`);

const WIRE_REFUSAL_CODES: ReadonlySet<string> = new Set([
    'epoch-transition-in-progress',
    'fence-incomplete',
    'fence-proof-unavailable',
    'lease-expired',
    'lease-state-unreadable',
    'malformed-request',
    'operation-payload-conflict',
    'reconciliation-required',
    'shutting-down',
    'spawn-rejected',
    // The credential push. Each says something the parent can act on: wire the
    // capability, renew again, or look at the runtime's disk.
    'capability-unavailable',
    'credential-expired',
    'credential-not-mine',
    'credential-not-newer',
    'credential-unreadable',
    'credential-unwritable',
    /**
     * The runtime did not take a checkpoint target the parent issued — most
     * often because it has no checkpoint session wired at all. The parent's
     * next move is to stop issuing until that is true, rather than to keep
     * signing URLs nobody can use.
     */
    'checkpoint-target-refused',
    'stale-epoch',
    'stale-renewal',
    /**
     * A renewal and a spawn overlapped. Retryable, and refused rather than
     * waited on: a generation registered inside the renewal's window keeps the
     * deadline it launched with while the parent is told the lease moved.
     */
    'renewal-race',
    /**
     * The lease was extended nowhere that enforces it. The parent must not stop
     * renewing on this answer — it is the one case where "ok" would be followed
     * by a kill at the old deadline.
     */
    'renewal-not-enforced',
    'stopped-before-dispatch',
    ...TOKEN_REFUSAL_CODES,
    // Thrown directly at :178/:181, not via the `token-${reason}` prefix.
    'token-wrong-project',
    'token-unknown-key',
]);

/**
 * The single classifier put on the wire for every managed refusal.
 *
 * `ManagedRpcError.message` is `code: detail`, and the detail — however short —
 * is not part of the contract. Shipping the message verbatim would make every
 * future detail string a wire field nobody reviewed.
 */
const MANAGED_REFUSAL_ERROR = 'managed dispatch refused';

/**
 * Code reported when the managed boundary cannot classify a failure. It is
 * deliberately not one of `WIRE_REFUSAL_CODES`: a caller must be able to tell
 * "the daemon refused for reason X" from "something failed and nobody knows
 * what", and must never read the second as the first.
 */
const MANAGED_UNKNOWN_CODE = 'managed-unknown-failure';

/**
 * Normalises **every** failure that escapes a managed handler.
 *
 * `RpcHandlerManager` turns a thrown error into `{ error: message }` on the
 * wire *and* logs `{ error }`. Rethrowing here would therefore publish whatever
 * an unexpected exception carries — a provider URL, a token, prompt text — and
 * break the safe-error promise this boundary exists to make. So nothing is
 * rethrown: managed refusals become their code, anything else becomes the
 * unknown classifier.
 *
 * Teaching the generic class about managed types would couple every BYOS caller
 * to the daemon's managed surface, so the conversion lives here instead and
 * emits the same `{ error, code }` shape the manager's own managed allowlist
 * rejection already uses. **BYOS handlers keep the existing fail path.**
 */
async function normalizeManagedRefusal<T>(
    run: () => T | Promise<T>,
): Promise<T | { error: string; code: string; diagnostic?: string }> {
    try {
        // `await` covers both shapes: `receipt` answers synchronously while the
        // others are async, and a synchronous throw must be normalised too.
        return await run();
    } catch (error: unknown) {
        if (error instanceof ManagedRpcError && WIRE_REFUSAL_CODES.has(error.code)) {
            return {
                error: MANAGED_REFUSAL_ERROR,
                code: error.code,
                ...(error.diagnostic === undefined ? {} : { diagnostic: error.diagnostic }),
            };
        }
        // No `error.message`, no stack, no cause — not on the wire and not in
        // the log. A fixed line keeps the failure visible without carrying its
        // payload; the daemon's own diagnostics keep the detail locally.
        logger.debug('[managed] handler failed with an unclassified error');
        return { error: MANAGED_REFUSAL_ERROR, code: MANAGED_UNKNOWN_CODE };
    }
}

/** `managed:spawn` → `spawn`. The handler's name is the method without prefix. */
type ManagedRpcHandlerName = (typeof MANAGED_RPC_METHODS)[number] extends `managed:${infer Name}`
    ? Name
    : never;

/*
 * Every method in the list names a real handler. A method added above with no
 * handler behind it fails the build here rather than at the first call.
 */
const _everyMethodHasAHandler: ManagedRpcHandlerName extends keyof ManagedRpcHandlers ? true : never = true;
void _everyMethodHasAHandler;

export function registerManagedRpcHandlers(
    registrar: RpcRegistrar,
    handlers: ManagedRpcHandlers,
): void {
    for (const method of MANAGED_RPC_METHODS) {
        const name = method.slice('managed:'.length) as ManagedRpcHandlerName;
        /*
         * 배선만 한다. 각 handler 의 params 타입은 그 handler 안에서 검사하고,
         * 여기서 형을 좁히려 하면 목록이 다시 갈라질 자리를 만든다.
         */
        const handler = handlers[name] as (params: unknown) => unknown;
        registrar.registerHandler(method, (params) => normalizeManagedRefusal(() => handler(params)));
    }
}

/**
 * The only RPC methods a managed runtime serves.
 *
 * An allowlist, not a denylist: a denylist silently admits every method added
 * later, and the point of this gate is that a future RPC cannot become a bypass
 * simply by existing.
 */
export const MANAGED_ALLOWED_RPCS: readonly string[] = MANAGED_RPC_METHODS;

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
