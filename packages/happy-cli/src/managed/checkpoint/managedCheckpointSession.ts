/**
 * The one checkpoint runner a managed runtime has, and the coordinator that
 * drives it.
 *
 * Every piece of T13/T14 existed and none of it was connected: a runner nobody
 * built, a coordinator nobody ticked, and a drain nobody handed to the writers.
 * The result was a runtime that could describe a checkpoint and never take one.
 * This is the composition, and it is deliberately **one per runtime**.
 *
 * ## Why one
 *
 * The drain is the whole point. It is the gate that says "no writes are in
 * flight", and a gate only means that if every writer goes through the same
 * one. Two runners on a runtime means two gates, each certain the volume is
 * quiet while the other's writers are running — an archive taken across a
 * half-written tree, which is worse than no checkpoint because it looks like
 * one. So the runner is created here once and its `checkpointDrain` is what
 * every writer is given.
 *
 * ## What it refuses to invent
 *
 * The volume, the tenant, the image version and the areas come from the
 * verified marker, not from anything this file decides. The publish targets are
 * per-attempt and come from the parent: signed URLs with a CAS pointer, live
 * for one checkpoint. A runtime that cannot get them takes no checkpoint and
 * says so — it does not fall back to writing somewhere of its own choosing.
 */
import type { CheckpointArea } from './managedCheckpointScope';
import type { CheckpointAreaSource } from './managedCheckpointArchive';
import type { CheckpointFlushDeps } from './managedCheckpointFlush';
import type { CheckpointFetch } from './managedCheckpointObjectStore';
import {
    createManagedCheckpointRunner,
    type ManagedCheckpointRequest,
    type ManagedCheckpointRunner,
} from './managedCheckpointRunner';
import type { ProviderQuiescenceGate } from '@/managed/checkpoint/managedProviderQuiescence';
import {
    createManagedCheckpointCoordinator,
    type ManagedCheckpointCoordinator,
    type ManagedCheckpointTargetSource,
} from './managedCheckpointCoordinator';
import type { CheckpointSchedulePolicy } from './managedCheckpointSchedule';

/** Where a checkpoint stages its sealed objects, on the run's own volume. */
export const MANAGED_CHECKPOINT_WORK_DIR = '/workspace/.saycode/checkpoints';

/** The project tree, and the provider's own state beside it. */
export function managedCheckpointAreas(input: {
    projectRoot: string;
    providerStateRoot: string;
}): CheckpointAreaSource[] {
    return [
        { area: 'project' satisfies CheckpointArea, root: input.projectRoot },
        { area: 'provider-state' satisfies CheckpointArea, root: input.providerStateRoot },
    ];
}

export type ManagedCheckpointSession = {
    runner: ManagedCheckpointRunner;
    coordinator: ManagedCheckpointCoordinator;
    /**
     * The single gate. Hand this to every writer — the tool session, and
     * anything else that touches the volume — or the drain proves nothing.
     */
    checkpointDrain: ManagedCheckpointRunner['checkpointDrain'];
};

export function createManagedCheckpointSession(config: {
    /** From the verified marker, never from a request. */
    tenant: { tenantId: string; projectId: string };
    /**
     * Asked per attempt, because the observer answers after boot. `null` blocks
     * the checkpoint rather than binding an archive to a volume nobody has
     * confirmed is the one under this runtime.
     */
    volume: () => { volumeId: string; deviceUuid: string } | null;
    image: { imageVersion: string };
    areas: CheckpointAreaSource[];
    /** Which tools change the workspace; from the tool set actually served. */
    writeTools: ReadonlySet<string>;
    /** How long a checkpoint may wait for in-flight writes. */
    drainBudgetMs: number;
    flushDeps: CheckpointFlushDeps;
    /**
     * The parent's per-attempt publish targets, fetched when a checkpoint is
     * actually going to happen. `null` means the parent has issued none — a
     * skipped checkpoint, not a failure of the volume.
     */
    targets: ManagedCheckpointTargetSource;
    /** Configured, never defaulted; `null` takes no checkpoints. */
    policy: CheckpointSchedulePolicy | null;
    /**
     * The provider-quiescence gate, **read when a checkpoint is attempted**.
     *
     * A reference rather than a value because the gate is built from the
     * supervisor, which does not exist when this session is composed. Its `null`
     * means "not wired yet", which is a refusal — not "this runtime archives no
     * provider state", which is what omitting the field means.
     */
    providerQuiescence?: () => ProviderQuiescenceGate | null;
    providerStateSessions?: readonly string[];
    workDir?: string;
    now?: () => number;
    /**
     * Supplied only by tests. Production uses the global `fetch`: the targets
     * are presigned URLs from the parent, and there is no second transport.
     */
    fetchImpl?: CheckpointFetch;
}): ManagedCheckpointSession {
    const now = config.now ?? Date.now;
    const runner = createManagedCheckpointRunner({
        tenant: config.tenant,
        volume: config.volume,
        image: config.image,
        sources: config.areas,
        ...(config.providerStateSessions ? { providerStateSessions: config.providerStateSessions } : {}),
        workDir: config.workDir ?? MANAGED_CHECKPOINT_WORK_DIR,
        drainBudgetMs: config.drainBudgetMs,
        writeTools: config.writeTools,
        flushDeps: config.flushDeps,
        now,
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    });
    const coordinator = createManagedCheckpointCoordinator({
        runner,
        targets: config.targets,
        policy: config.policy,
        volume: config.volume,
        /*
         * **늦게 배선된다.** 이 게이트는 supervisor 에서 만들어지고, supervisor 는
         * 이 세션이 만들어진 뒤에 생긴다. 그래서 값이 아니라 참조를 넘긴다 —
         * 참조가 비어 있는 동안 tick 이 돌면 coordinator 가 "아직 물을 수 없다"
         * 로 거절하며, 그것을 "이 runtime 은 provider state 를 담지 않는다" 로
         * 읽지 않는다.
         */
        ...(config.providerQuiescence
            ? { providerQuiescence: config.providerQuiescence }
            : {}),
    });
    return { runner, coordinator, checkpointDrain: runner.checkpointDrain };
}

/**
 * The parent's publish targets for one attempt.
 *
 * Wrapped rather than used directly so a transport failure stays a failure: the
 * coordinator distinguishes "the parent issued none" (`null`, a skip) from "we
 * could not ask" (a throw, counted against the runtime). Collapsing the second
 * into the first would report a runtime as merely un-checkpointed while its
 * credentials were broken.
 */
export function createManagedCheckpointTargets(input: {
    next: () => Promise<ManagedCheckpointRequest | null>;
}): ManagedCheckpointTargetSource {
    return { next: input.next };
}
