/**
 * The order a runtime has to bring its checkpointing up in, in one place.
 *
 * Four things happen and the sequence is the correctness argument, not a
 * preference:
 *
 * 1. **The gate reference exists before the composition.** The gate observes
 *    the tool drain, and the drain is created *by* the composition — so the
 *    gate cannot exist yet and the composition is handed a reference. While it
 *    answers `null` the coordinator refuses `gate-not-wired`, which is the
 *    honest state: the question cannot be asked yet.
 * 2. **`start()`**, which takes the supervisor's lock and begins listening.
 * 3. **`reconcile()`**, which arms the generations a previous supervisor left
 *    running. A proof taken before this reads a writer nobody is watching as
 *    quiet, so the gate is not wired until it has run.
 * 4. **The gate, then the ticks.** In that order: a tick that beat the gate
 *    into place would refuse itself for a reason that says nothing about the
 *    runtime.
 *
 * This lived inline in the boot's `startSupervisor` dependency, which needs
 * root, cgroups and a listening socket — so the order was asserted by reading
 * it. Here it is a function, and the order is asserted by a test.
 */
import type { ManagedCheckpointSession } from './managedCheckpointSession';
import type { CheckpointSchedulePolicy } from './managedCheckpointSchedule';
import type { ProviderQuiescenceGate } from './managedProviderQuiescence';
import type { ManagedCheckpointTickLoop } from './managedCheckpointTickLoop';
import { startManagedCheckpointTicks } from './managedCheckpointTicks';

/** What the gate is allowed to know about the drain: three observations. */
export type CheckpointDrainObservations = {
    inFlight: () => number;
    isDraining: () => boolean;
    writes: () => number;
};

/**
 * The supervisor, as this file needs it.
 *
 * `providerQuiescence` is **required**, and it returns a gate rather than
 * `null`: a runtime with no way to end its provider's input gets a gate that
 * refuses `eof-unverified`, which is an answer. An API that could return
 * nothing would be the permanent "no gate" baseline again, and that reads as
 * permission to archive provider state nobody proved was flushed.
 *
 * It may still throw, and that throw is **not caught here**. The production
 * boot always passes `managedRun`, so a supervisor that cannot build a gate is
 * a broken configuration, not a runtime without a channel — the channel-less
 * case already has an answer, which is a gate that refuses. Catching it and
 * serving work anyway would lose a prerequisite quietly and rebuild the
 * permanent "no gate" baseline behind a debug line: the runtime would run,
 * archive nothing of the provider's state, and say so nowhere the operator
 * looks. The boot classifies and refuses instead.
 */
export type CheckpointableSupervisorRuntime = {
    start: () => Promise<void>;
    reconcile: () => unknown;
    /**
     * Undoes `start()`. Required, because this sequence can fail **after** the
     * supervisor is listening and holding its lock: leaving that behind would
     * make the next boot's lock acquisition fail for a reason that has nothing
     * to do with it.
     */
    stop: () => Promise<unknown>;
    providerQuiescence: (input: {
        drain: CheckpointDrainObservations;
        /** How long one generation gets to end its input and leave. */
        endInputBudgetMs: number;
    }) => ProviderQuiescenceGate;
};

export type ManagedRuntimeCheckpointing = {
    /**
     * Hand this to the composition. Late-bound on purpose: its `null` means
     * "not wired yet" — a refusal — and never "this runtime archives no
     * provider state".
     */
    gate: () => ProviderQuiescenceGate | null;
    /**
     * Starts the supervisor, reconciles, wires the gate, then arms the ticks.
     *
     * Returns the loop so whoever owns the process can wait for a checkpoint in
     * flight on the way down; `null` when the marker carries no schedule, which
     * is a runtime that takes no checkpoints at all.
     */
    startAfterSupervisor: (input: {
        runtime: CheckpointableSupervisorRuntime;
        /** The composed session — the same one the tool writers were given. */
        checkpoint: ManagedCheckpointSession;
        /** From the marker. `null` takes no checkpoints. */
        schedule: CheckpointSchedulePolicy | null;
    }) => Promise<ManagedCheckpointTickLoop | null>;
};

export function createManagedRuntimeCheckpointing(config: {
    shutdownWaitMs: number;
    /**
     * The bound the gate gives a generation to end its input and exit.
     * Configured by the caller; nothing here invents one.
     */
    endInputBudgetMs: number;
    /** Fixed classifiers only. */
    onTick?: (outcome: { trigger: string; kind: string; reason?: string; detail?: string }) => void;
    /** Told when a tick begins; a start with no outcome is a hang. */
    onTickStart?: (outcome: { trigger: string }) => void;
    /**
     * Told whether a consumer was armed, and at what interval.
     *
     * `intervalMs: null` means the marker carries no schedule, so nothing ticks.
     * Reported through the same guard as every other observer here: the caller
     * writes this to a log, and a log append can fail — a boot that died because
     * its own diagnostic threw would be a diagnostic taking down the work it
     * exists to describe, after the supervisor is already listening.
     */
    onArmed?: (outcome: { intervalMs: number | null }) => void;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
    clearTimer?: (handle: NodeJS.Timeout | number) => void;
}): ManagedRuntimeCheckpointing {
    let gate: ProviderQuiescenceGate | null = null;
    return {
        gate: () => gate,
        async startAfterSupervisor({ runtime, checkpoint, schedule }) {
            await runtime.start();
            runtime.reconcile();
            /*
             * 재조정 **뒤**에 배선한다. 앞이면 이전 supervisor 가 띄운 세대가 아직
             * 무장되지 않았고, 그 상태의 증명은 아무도 보고 있지 않은 세대를
             * 조용하다고 읽는다.
             *
             * 넘기는 drain 은 합성이 만든 그 객체다 — tool 이 쓰는 게이트와 증명이
             * 보는 게이트가 다르면 증명은 아무것도 배제하지 못한다.
             */
            // The caller owns startup cleanup, including failure after start acquired its lock.
            // Propagate this prerequisite failure; never arm ticks without the gate.
            gate = runtime.providerQuiescence({
                drain: checkpoint.checkpointDrain.drain,
                endInputBudgetMs: config.endInputBudgetMs,
            });
            const loop = startManagedCheckpointTicks({
                coordinator: checkpoint.coordinator,
                schedule,
                shutdownWaitMs: config.shutdownWaitMs,
                ...(config.onTick ? { onTick: config.onTick } : {}),
                ...(config.onTickStart ? { onTickStart: config.onTickStart } : {}),
                ...(config.now ? { now: config.now } : {}),
                ...(config.setTimer ? { setTimer: config.setTimer } : {}),
                ...(config.clearTimer ? { clearTimer: config.clearTimer } : {}),
            });
            try {
                config.onArmed?.({ intervalMs: loop === null ? null : schedule?.periodMs ?? null });
            } catch {
                // 진단이 부팅을 되돌리면 안 된다. supervisor 는 이미 서 있다.
            }
            return loop;
        },
    };
}
