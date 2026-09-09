/**
 * Local observation of whether a managed child's process group is still there.
 *
 * This module reports evidence and never a verdict. A child can call `setsid`
 * and leave the group, so an empty group says only "nothing of it is visible
 * from here" — not that nothing survived. Proving that requires cgroup
 * emptiness or a provider stop, and T09 owns both. `onChildExited` and a dead
 * leader pid are equally weak: the leader can exit while its children keep
 * writing to the workspace.
 *
 * Signal failures are classified, never swallowed. `EPERM` in particular means
 * the target is alive but owned by another uid — which is the normal case once
 * agents run under their own uid — and reading it as "gone" would let a new
 * writable generation open on top of a live writer.
 */

export type ProcessGroupEvidence =
    /** Nothing from this group is visible here. Not proof that nothing runs. */
    | { kind: 'no-local-trace' }
    | { kind: 'alive' }
    /** Alive, but this daemon may not signal it (different uid). */
    | { kind: 'alive-foreign' }
    /** The signal failed for a reason we cannot interpret. Never "gone". */
    | { kind: 'indeterminate'; detail: string };

export type SignalOutcome =
    | { kind: 'delivered' }
    | { kind: 'no-local-trace' }
    | { kind: 'not-permitted' }
    | { kind: 'indeterminate'; detail: string };

export type ProcessGroupDeps = {
    /** Negative pid targets the whole group; that is the point of this module. */
    kill: (target: number, signal: NodeJS.Signals | 0) => void;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
};

export const defaultProcessGroupDeps: ProcessGroupDeps = {
    kill: (target, signal) => process.kill(target, signal),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
};

function classify(error: unknown): SignalOutcome {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { kind: 'no-local-trace' };
    if (code === 'EPERM') return { kind: 'not-permitted' };
    return { kind: 'indeterminate', detail: code ?? 'signal failed' };
}

export function signalProcessGroup(
    pgid: number,
    signal: NodeJS.Signals | 0,
    deps: ProcessGroupDeps = defaultProcessGroupDeps,
): SignalOutcome {
    if (!Number.isSafeInteger(pgid) || pgid <= 1) {
        // pgid 1 would signal init, and a non-integer means a corrupt receipt.
        return { kind: 'indeterminate', detail: 'invalid pgid' };
    }
    try {
        deps.kill(-pgid, signal);
        return { kind: 'delivered' };
    } catch (error) {
        return classify(error);
    }
}

export function probeProcessGroup(
    pgid: number,
    deps: ProcessGroupDeps = defaultProcessGroupDeps,
): ProcessGroupEvidence {
    const outcome = signalProcessGroup(pgid, 0, deps);
    switch (outcome.kind) {
        case 'delivered':
            return { kind: 'alive' };
        case 'no-local-trace':
            return { kind: 'no-local-trace' };
        case 'not-permitted':
            return { kind: 'alive-foreign' };
        case 'indeterminate':
            return { kind: 'indeterminate', detail: outcome.detail };
    }
}

/**
 * Whether this process may signal the group at all.
 *
 * A stored pgid is just a number. After a daemon restart the kernel may have
 * reused it for something unrelated, so signalling on the strength of a
 * persisted value can kill a bystander. Only a child this process is still
 * tracking carries the ownership needed to signal; anything else is observed
 * and handed to the privileged backend that T09 will provide.
 */
export type ProcessGroupOwnership =
    | { kind: 'live-tracked-child' }
    | { kind: 'unverified' };

export type ProcessGroupStopResult = {
    evidence: ProcessGroupEvidence;
    escalated: boolean;
    /** False when ownership could not be established, or input was invalid. */
    signalled: boolean;
    /** Set when the stop was handed off rather than performed. */
    deferredTo?: 'privileged-backend';
    /** Outcome of the SIGKILL escalation, kept so a failure is not lost. */
    killOutcome?: SignalOutcome;
};

function isBoundedMs(value: number, min: number): boolean {
    return Number.isFinite(value) && value >= min;
}

/**
 * Asks the group to stop, escalates, and reports what was observed afterwards.
 *
 * The evidence type is the same one a plain probe returns: having sent SIGKILL
 * does not upgrade "no local trace" into "stopped".
 */
export async function requestProcessGroupStop(input: {
    pgid: number;
    graceMs: number;
    pollMs?: number;
    ownership: ProcessGroupOwnership;
    deps?: ProcessGroupDeps;
}): Promise<ProcessGroupStopResult> {
    const deps = input.deps ?? defaultProcessGroupDeps;
    const pollMs = input.pollMs ?? 200;

    // An unbounded grace or a zero poll turns the loops below into a hang, and
    // a hung stop looks identical to a stop that is merely slow.
    if (!isBoundedMs(input.graceMs, 0) || !isBoundedMs(pollMs, 1)) {
        return {
            evidence: { kind: 'indeterminate', detail: 'invalid grace or poll interval' },
            escalated: false,
            signalled: false,
        };
    }

    if (input.ownership.kind !== 'live-tracked-child') {
        // Observe only. The number may name someone else's process now.
        return {
            evidence: probeProcessGroup(input.pgid, deps),
            escalated: false,
            signalled: false,
            deferredTo: 'privileged-backend',
        };
    }

    const term = signalProcessGroup(input.pgid, 'SIGTERM', deps);
    if (term.kind === 'no-local-trace') {
        return { evidence: { kind: 'no-local-trace' }, escalated: false, signalled: true };
    }
    if (term.kind === 'not-permitted') {
        return { evidence: { kind: 'alive-foreign' }, escalated: false, signalled: true };
    }
    if (term.kind === 'indeterminate') {
        return { evidence: { kind: 'indeterminate', detail: term.detail }, escalated: false, signalled: true };
    }

    const deadline = deps.now() + input.graceMs;
    while (deps.now() < deadline) {
        const evidence = probeProcessGroup(input.pgid, deps);
        if (evidence.kind !== 'alive') return { evidence, escalated: false, signalled: true };
        await deps.sleep(pollMs);
    }

    const killOutcome = signalProcessGroup(input.pgid, 'SIGKILL', deps);
    if (killOutcome.kind === 'not-permitted' || killOutcome.kind === 'indeterminate') {
        // Dropping this would report a clean stop for a group we could not kill.
        return {
            evidence: killOutcome.kind === 'not-permitted'
                ? { kind: 'alive-foreign' }
                : { kind: 'indeterminate', detail: killOutcome.detail },
            escalated: true,
            signalled: true,
            killOutcome,
        };
    }

    // SIGKILL is not instantaneous and the kernel may not have reaped yet, so
    // the group is polled again rather than assumed gone.
    const afterKillDeadline = deps.now() + input.graceMs;
    while (deps.now() < afterKillDeadline) {
        const evidence = probeProcessGroup(input.pgid, deps);
        if (evidence.kind !== 'alive') return { evidence, escalated: true, signalled: true, killOutcome };
    await deps.sleep(pollMs);
    }
    return {
        evidence: probeProcessGroup(input.pgid, deps),
        escalated: true,
        signalled: true,
        killOutcome,
    };
}

/**
 * Whether a set of observations is enough to open a new writable generation.
 *
 * It never is on its own — `requiresExternalProof` is true whenever anything
 * was seen, and the caller must obtain cgroup emptiness or a provider stop
 * before raising the epoch.
 */
export function summarizeFencingEvidence(
    observations: readonly ProcessGroupEvidence[],
): { allClear: boolean; requiresExternalProof: boolean; reasons: string[] } {
    const reasons: string[] = [];
    for (const observation of observations) {
        if (observation.kind === 'alive') reasons.push('group-alive');
        else if (observation.kind === 'alive-foreign') reasons.push('group-alive-foreign');
        else if (observation.kind === 'indeterminate') reasons.push(`indeterminate:${observation.detail}`);
    }
    return {
        allClear: reasons.length === 0,
        // Even "all clear" needs external proof: a setsid child is invisible to
        // every check this process can perform.
        requiresExternalProof: true,
        reasons,
    };
}
