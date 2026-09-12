/**
 * The runtime's own checkpoint consumer: what actually asks for one.
 *
 * The coordinator decides, the publisher archives, the inbox holds the parent's
 * targets — and until this existed, nothing on a running runtime asked. Every
 * piece reported healthy and the volume was never checkpointed, which is the
 * failure mode that reads as a working feature from every angle except the
 * store.
 *
 * ## Two things it will not invent
 *
 * **The cadence.** `periodMs` comes from the verified marker's checkpoint
 * schedule. With no schedule there is nothing to tick — this returns `null`
 * rather than picking an interval, because a runtime checkpointing on a cadence
 * nobody configured is spending a tenant's bandwidth on this file's opinion.
 *
 * **Idleness.** This runtime has no activity collector and no idle policy:
 * `evaluateRuntimeIdle` has no production caller, and the marker carries no
 * `RuntimeIdlePolicy`. So the answer passed to every tick is
 * `undecidable / no-policy` — the truth. Reporting `idle` would be a fabricated
 * observation, and reporting `active` would be a runtime that never checkpoints.
 * The coordinator's own rules then apply: `undecidable` blocks a checkpoint only
 * when it is `unproven-writer`, because a checkpoint does not need an idle
 * runtime — the drain is what makes the archive consistent — while a writer
 * nobody can account for does block it.
 */
import type { RuntimeIdleDecision } from '@/managed/managedRuntimeActivity';

import type { ManagedCheckpointCoordinator } from './managedCheckpointCoordinator';
import type { CheckpointSchedulePolicy } from './managedCheckpointSchedule';
import {
    createManagedCheckpointTickLoop,
    type ManagedCheckpointTickLoop,
} from './managedCheckpointTickLoop';

/**
 * What this runtime can honestly say about being in use: nothing.
 *
 * Exported so a test asserts the real value rather than a copy of it, and so
 * the day an activity collector exists there is one place that changes.
 */
export const MANAGED_RUNTIME_IDLE_UNKNOWN: RuntimeIdleDecision = {
    state: 'undecidable',
    reason: 'no-policy',
};

export function startManagedCheckpointTicks(input: {
    coordinator: ManagedCheckpointCoordinator;
    /** From the marker. `null` means this runtime takes no checkpoints. */
    schedule: CheckpointSchedulePolicy | null;
    /**
     * How long a shutdown may wait for an attempt in flight. Configured by the
     * caller; a checkpoint mid-upload is worth waiting for, but not forever.
     */
    shutdownWaitMs: number;
    /** Fixed classifiers only — no dependency messages, no paths. */
    onTick?: (outcome: { trigger: string; kind: string; reason?: string; detail?: string }) => void;
    /**
     * Told when a tick begins, so a hung attempt is not the same silence as a
     * consumer that never ran.
     */
    onTickStart?: (outcome: { trigger: string }) => void;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout | number;
    clearTimer?: (handle: NodeJS.Timeout | number) => void;
}): ManagedCheckpointTickLoop | null {
    if (!input.schedule) return null;
    const loop = createManagedCheckpointTickLoop({
        coordinator: input.coordinator,
        intervalMs: input.schedule.periodMs,
        idle: () => MANAGED_RUNTIME_IDLE_UNKNOWN,
        now: input.now ?? Date.now,
        shutdownWaitMs: input.shutdownWaitMs,
        ...(input.onTick ? { onTick: input.onTick } : {}),
        ...(input.onTickStart ? { onTickStart: input.onTickStart } : {}),
        ...(input.setTimer ? { setTimer: input.setTimer } : {}),
        ...(input.clearTimer ? { clearTimer: input.clearTimer } : {}),
    });
    loop.start();
    return loop;
}

/** What a signal handler may do to the process, injected so it can be tested. */
export type ManagedShutdownProcess = {
    on: (signal: NodeJS.Signals, handler: () => void) => void;
    removeListener: (signal: NodeJS.Signals, handler: () => void) => void;
    kill: (pid: number, signal: NodeJS.Signals) => void;
    pid: number;
};

/**
 * Lets a checkpoint already in flight finish before this process is stopped.
 *
 * An archive uploaded with its pointer unpublished is a checkpoint that exists
 * and that nothing can find, so a stop that arrives mid-attempt is worth a
 * bounded wait. The bound is the loop's own `shutdownWaitMs`.
 *
 * ## It does not make the runtime harder to kill
 *
 * Installing a `SIGTERM` listener replaces Node's default action, so the
 * handler **re-raises** the same signal with its own listeners removed once the
 * wait is over: the machine still stops, just after the pointer is written or
 * after the bound, whichever comes first. A second signal during the wait goes
 * straight through for the same reason — the listener is gone by then.
 *
 * With no loop to wait for, **nothing is installed at all**. A handler that
 * exists only to re-raise would change this process's signal behaviour for no
 * benefit, and the supervisor's lifetime is not this function's to alter.
 */
export function drainManagedCheckpointTicksOnSignal(input: {
    ticks: ManagedCheckpointTickLoop | null;
    signals?: readonly NodeJS.Signals[];
    /** Fixed classifiers: which signal, and whether a publication was left. */
    onStopped?: (outcome: { signal: NodeJS.Signals; pendingPublication: boolean }) => void;
    process?: ManagedShutdownProcess;
}): void {
    const ticks = input.ticks;
    if (!ticks) return;
    const target = input.process ?? {
        on: (signal, handler) => { process.on(signal, handler); },
        removeListener: (signal, handler) => { process.removeListener(signal, handler); },
        kill: (pid, signal) => { process.kill(pid, signal); },
        pid: process.pid,
    };
    const signals = input.signals ?? (['SIGTERM', 'SIGINT'] as const);
    const handlers = new Map<NodeJS.Signals, () => void>();
    const detach = (): void => {
        for (const [signal, handler] of handlers) target.removeListener(signal, handler);
        handlers.clear();
    };
    for (const signal of signals) {
        const handler = (): void => {
            // 첫 신호에서 바로 뗀다. 기다리는 동안 온 두 번째 신호는 기본 동작
            // 으로 지나가야 한다 — 못 죽는 runtime 을 만들지 않는다.
            detach();
            void ticks.stop()
                .then(({ pendingPublication }) => {
                    input.onStopped?.({ signal, pendingPublication });
                })
                .catch(() => {
                    // 멈추다 실패한 것도 "정산되지 않은 채 내려간다" 는 사실이다.
                    input.onStopped?.({ signal, pendingPublication: true });
                })
                .finally(() => { target.kill(target.pid, signal); });
        };
        handlers.set(signal, handler);
        target.on(signal, handler);
    }
}
