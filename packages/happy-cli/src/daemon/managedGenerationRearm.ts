/**
 * Re-arming the generation watchdogs a lease grant just extended.
 *
 * The supervisor arms a watchdog per generation **at launch**, from the lease
 * live at that moment, and the only thing that moves it is the IPC `renew`.
 * A grant that updates the daemon's deadline and stops there leaves the
 * enforcer holding the old one — measured in a deployed runtime as a SIGKILL
 * at `launch + leaseMs`, within 9ms, three times.
 *
 * Exported rather than inlined in `run.ts` so the regression can drive the
 * **same** implementation the daemon runs. A test that re-states the decision
 * beside it proves only that two copies agree.
 */
export type GenerationKey = { runId: string; attemptId: string; epoch: number };

export type GenerationRearmOutcome =
    | { rearmed: GenerationKey[]; refused: null }
    /** The supervisor would not move a deadline; the grant is not renewed. */
    | { rearmed: GenerationKey[]; refused: RearmRefusal };


/**
 * Why a deadline was not moved, as a closed set.
 *
 * The backend's `detail` crosses an IPC boundary and is **not** reviewed text —
 * `launcherClient.renew` forwards whatever the socket said, down to a
 * `transport` fallback. Forwarding it into an RPC refusal and a log line puts
 * an unaudited string on the wire, so it is classified here and anything
 * unrecognised becomes `unclassified`. The recognised values are the ones
 * `supervisor.renewLease` and `generationManifest.proveStopped` produce today.
 */
const REARM_REFUSALS = {
    // supervisor.renewLease
    'invalid-renewal-seq': true,
    'invalid-expiry': true,
    'already-stopped': true,
    'lease-already-expired': true,
    'lease-expired': true,
    'stale-renewal': true,
    // generationManifest.proveStopped, forwarded by renewLease
    'never-launched': true,
    'termination-unknown': true,
    'termination-pending': true,
    'record-unreadable': true,
    // launcherClient transport
    'malformed-response': true,
    transport: true,
    unknown: true,
    /** Ours: the call itself threw, so the backend never answered. */
    unreachable: true,
} as const;

export type RearmRefusal =
    | keyof typeof REARM_REFUSALS
    /** The backend said something this set does not recognise. */
    | 'unclassified'
    /** A generation is live and this runtime has no enforcer to re-arm it. */
    | 'enforcement-unavailable';

const classifyRefusal = (detail: string): RearmRefusal =>
    Object.prototype.hasOwnProperty.call(REARM_REFUSALS, detail)
        ? detail as RearmRefusal
        : 'unclassified';

export async function rearmGenerationsForLease(input: {
    grant: {
        epoch: number;
        /** Absent on a runtime-scoped grant, which is the one the parent sends. */
        runId?: string;
        attemptId?: string;
        renewalSeq?: number;
        leaseExpiresMonotonic: number;
    };
    /** Every generation this daemon currently knows to be running. */
    liveGenerations: () => GenerationKey[];
    renew: (input: {
        key: GenerationKey;
        renewalSeq: number;
        leaseExpiresMonotonic: number;
    }) => Promise<{ renewed: boolean; detail: string }>;
}): Promise<GenerationRearmOutcome> {
    const { grant } = input;
    /*
     * Nothing may re-arm on a sequence it does not have: the supervisor
     * refuses one that does not advance, so an invented number is a silent
     * no-op that reads as success.
     */
    if (grant.renewalSeq === undefined) return { rearmed: [], refused: null };
    const renewalSeq = grant.renewalSeq;
    const leaseExpiresMonotonic = grant.leaseExpiresMonotonic;

    /*
     * A runtime-scoped grant names no run because it widens the window for
     * **every** generation — and it is the only lease the parent actually
     * sends. Gating this on a `runId` is why the first fix changed nothing in
     * the product.
     *
     * Only this epoch. A raised epoch is a fence, and extending a generation
     * below it would move a deadline for work that is supposed to be stopping.
     */
    const keys = grant.runId !== undefined && grant.attemptId !== undefined
        ? [{ runId: grant.runId, attemptId: grant.attemptId, epoch: grant.epoch }]
        : dedupe(input.liveGenerations().filter((key) => key.epoch === grant.epoch));

    const answers = await Promise.all(keys.map(async (key) => ({
        key,
        answer: await input.renew({ key, renewalSeq, leaseExpiresMonotonic })
            .catch(() => ({ renewed: false, detail: 'unreachable' })),
    })));

    /*
     * One pass is the whole set.
     *
     * A spawn admitted while this awaits the supervisor would register a
     * generation behind the snapshot, armed at the old deadline and re-armed by
     * nobody. The RPC holds admission until the renewal settles, so that cannot
     * happen — asserted in `managedRuntimeLeaseRearm.test.ts` rather than
     * guarded a second time here, because two guards on one latch is how the
     * previous round of this bug survived.
     */
    const refused = answers.find((entry) => !entry.answer.renewed);
    const rearmed = answers.filter((entry) => entry.answer.renewed).map((entry) => entry.key);
    return refused
        ? { rearmed, refused: classifyRefusal(refused.answer.detail) }
        : { rearmed, refused: null };
}

const identity = (key: GenerationKey): string =>
    JSON.stringify([key.runId, key.attemptId, key.epoch]);

/** One generation, once. Two pids of the same generation are still one deadline. */
function dedupe(keys: GenerationKey[]): GenerationKey[] {
    const seen = new Set<string>();
    return keys.filter((key) => {
        const id = identity(key);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
}

/**
 * The same re-arm, in the shape the lease RPC consumes.
 *
 * `enforceLeaseUntil` awaits `onLeaseRenewed` and turns `enforced: false` into
 * `renewal-not-enforced`, refusing the grant without writing anything. That
 * translation lives here rather than at the daemon's call site so a test can
 * drive the real one: a copy at the call site would keep answering `enforced`
 * after the real one stopped, which is the failure this whole change is about.
 */
export async function enforceLeaseByRearming(input: Parameters<typeof rearmGenerationsForLease>[0] & {
    /** A classifier, never the supervisor's own text. */
    onRefused?: (code: RearmRefusal) => void;
}): Promise<{ enforced: boolean; detail?: RearmRefusal }> {
    const outcome = await rearmGenerationsForLease(input);
    if (outcome.refused === null) return { enforced: true };
    input.onRefused?.(outcome.refused);
    return { enforced: false, detail: outcome.refused };
}

/**
 * Relays the parent's runtime-scoped grant to the supervisor, before the
 * per-generation fan-out above.
 *
 * Its sibling turns the supervisor's per-generation answers into an
 * enforcement verdict; this turns its answer about the **grant** into the same
 * kind of verdict, and both are decisions the composition root should only be
 * calling rather than containing.
 *
 * Three refusals, each closing a path that would otherwise answer `enforced`
 * with nothing having observed the grant:
 *
 * - **the envelope is missing on a runtime-scoped renewal.** With no live
 *   generation the fan-out is vacuously enforced, so a dropped envelope would
 *   be ACKed as an enforced grant. Absence refuses instead.
 * - **no launch backend.** Nothing to relay to. A null backend is a degraded or
 *   refused state rather than a supported ready path (the binding is written
 *   before READY), and a non-null one is not proof of a live listener either -
 *   constructing a client proves no listener, and the F2 hello that would is
 *   still pending.
 * - **the supervisor did not admit it.** Its reason stays there; only a
 *   classifier travels.
 *
 * The run-scoped `managed:lease` carries a run and no envelope: it relays
 * nothing and keeps the answer it always had.
 */
export async function relayRuntimeGrant(input: {
    grant?: { token: string; params: unknown };
    /** True for `managed:lease`, which names a run and relays no grant. */
    runScoped: boolean;
    backend: {
        pushRuntimeGrant: (grant: { token: string; params: unknown })
        => Promise<{ admitted: boolean; detail: string }>;
    } | null;
    liveGenerationCount: number;
}): Promise<{ enforced: boolean; detail?: string }> {
    if (!input.runScoped && !input.grant) {
        return { enforced: false, detail: 'grant-missing' };
    }
    if (!input.backend) {
        if (input.liveGenerationCount > 0) {
            return { enforced: false, detail: 'enforcement-unavailable' };
        }
        if (input.grant) return { enforced: false, detail: 'grant-unrelayable' };
        return { enforced: true };
    }
    if (input.grant) {
        const relayed = await input.backend.pushRuntimeGrant(input.grant)
            .catch(() => ({ admitted: false, detail: 'unreachable' }));
        if (!relayed.admitted) return { enforced: false, detail: 'grant-not-admitted' };
    }
    return { enforced: true };
}

/**
 * The whole enforcement answer for one lease renewal: relay, then fan out.
 *
 * Extracted so the composition root only *calls* it. The two decisions it makes
 * — the grant reaches a supervisor before any generation is re-armed, and a
 * refusal at either step is an enforcement refusal — are the ones a parent's
 * safety depends on, and while they lived inside `run.ts` no test could reach
 * them without booting a daemon. A test that re-implemented them would assert
 * its own copy, which is how the grant relay's first three mutations survived.
 */
export async function enforceLeaseRenewal(input: {
    grant?: { token: string; params: unknown };
    lease: {
        epoch: number;
        runId?: string;
        attemptId?: string;
        renewalSeq?: number;
        leaseExpiresMonotonic: number;
    };
    backend: {
        pushRuntimeGrant: (grant: { token: string; params: unknown })
        => Promise<{ admitted: boolean; detail: string }>;
        renew: (request: {
            key: GenerationKey; renewalSeq: number; leaseExpiresMonotonic: number;
        }) => Promise<{ renewed: boolean; detail: string }>;
    } | null;
    liveGenerations: () => GenerationKey[];
    /** A classifier, never the supervisor's own text. */
    onRefused?: (code: string) => void;
}): Promise<{ enforced: boolean; detail?: string }> {
    const live = input.liveGenerations();
    const relayed = await relayRuntimeGrant({
        grant: input.grant,
        runScoped: input.lease.runId !== undefined,
        backend: input.backend,
        liveGenerationCount: live.length,
    });
    if (!relayed.enforced) {
        if (relayed.detail) input.onRefused?.(relayed.detail);
        return relayed;
    }
    // No backend and nothing to enforce: the relay already decided that, and a
    // fan-out with no backend to call would be inventing an answer.
    if (!input.backend) return relayed;
    const backend = input.backend;
    return enforceLeaseByRearming({
        grant: { ...input.lease },
        liveGenerations: () => live,
        renew: (request) => backend.renew(request),
        onRefused: input.onRefused,
    });
}
