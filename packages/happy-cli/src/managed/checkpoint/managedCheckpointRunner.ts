/**
 * The thing a running runtime hands to whoever asks it for a checkpoint.
 *
 * Everything a checkpoint needs that does not change between checkpoints — the
 * tenant, the volume, which trees are archived, where the scratch space is —
 * is bound once, here. What the parent supplies per request is only what it
 * alone knows: which checkpoint this is, the signed URLs, and the one-use key.
 *
 * ## It owns the drain
 *
 * A drain only means something if the tool path and the checkpoint hold the
 * *same* one. Two instances would each be internally consistent and together
 * guarantee nothing, so this creates it and exposes it, rather than accepting
 * one and hoping. The tool session is given `runner.checkpointDrain` and every
 * write goes through it.
 *
 * ## One at a time
 *
 * A second checkpoint while one is running is refused by the drain itself
 * (`drain-in-progress`) rather than by a flag here — the gate is already the
 * thing that knows.
 *
 * This does not decide *when* to checkpoint. That is the parent's call,
 * arriving over RPC, and the registration of that method belongs to the daemon
 * side rather than here.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createCheckpointDrain, type CheckpointDrain } from './managedCheckpointDrain';
import type { CheckpointFlushDeps } from './managedCheckpointFlush';
import type { ManagedCheckpointManifest } from './managedCheckpointManifest';
import type { CheckpointFetch } from './managedCheckpointObjectStore';
import {
    publishManagedCheckpoint,
    type ManagedCheckpointPointer,
    type ManagedCheckpointPublishTargets,
} from './managedCheckpointPublisher';
import type { ProviderQuiescence } from './managedProviderQuiescence';
import type { ProviderStateScopeV1 } from './managedProviderStateScope';
import type { CheckpointAreaSource } from './managedCheckpointArchive';
import type { CheckpointArea } from './managedCheckpointScope';

/**
 * What the supervisor established about a target when it arrived.
 *
 * A closed, credential-free projection of the verified claims - no token, no
 * digest, no signature. `epoch` is `E_t`, **the epoch the parent signed for**:
 * a fact to compare against what this runtime independently observes, never
 * evidence that the epoch is current. Current authority remains a separate
 * question this carries no answer to.
 *
 * It travels **on the request**, not beside it: a receipt held somewhere else
 * is one that can be read after its target is gone, or lost when the target is
 * handed on - and the consumer that must eventually compare it is reached
 * through this object.
 */
export type ManagedCheckpointReceipt = {
    epoch: number;
    requestKey: string;
    issuedAtMs: number;
    expiresAtMs: number;
};

export type ManagedCheckpointRequest = {
    checkpointId: string;
    /**
     * What authenticated this target at receipt, carried with it.
     *
     * Optional in the type because the coordinator's own fixtures construct
     * requests directly; every request that came off the wire has one, because
     * the boundary refuses those it cannot authenticate. **Nothing consumes it
     * yet** - what a consumer may conclude from `epoch` needs a current
     * authority this process does not hold, and synthesising one is the exact
     * forgery this path exists to avoid.
     */
    receipt?: ManagedCheckpointReceipt;
    /** Live for this checkpoint only; never written to the volume. */
    key: Buffer;
    targets: ManagedCheckpointPublishTargets;
    /** Take the checkpoint even though some databases could not be flushed. */
    acknowledgeUnsupportedDatabases?: boolean;
    /**
     * Which sessions the parent says this checkpoint is meant to carry.
     *
     * Declared rather than left to ride along: `inbox.next()` strips
     * `expiresAt` with a rest spread, so the scope reached here structurally
     * while the type said nothing about it - and a field the types do not know
     * is one the next hop can drop without anything noticing.
     *
     * **Nothing consumes it yet.** The comparison it exists for happens inside
     * the held drain, against the generations the quiescence proof reports, and
     * the trusted axes that comparison needs (runtime, workspace, operation,
     * live lease epoch) are not available at this layer. Carrying it no further
     * than this is deliberate; see the freeze notes.
     */
    providerStateScope?: ProviderStateScopeV1;
};

export type ManagedCheckpointRunner = {
    /** Give this to the tool session, so writes and checkpoints share one gate. */
    checkpointDrain: {
        drain: CheckpointDrain;
        writeTools: ReadonlySet<string>;
    };
    /**
     * The areas this runner actually archives.
     *
     * Read from the runner rather than declared beside it: whether a checkpoint
     * needs a proof that the provider settled depends on whether provider state
     * is in the archive, and only the thing doing the archiving knows that. A
     * caller-supplied answer can be wrong in the direction that matters.
     */
    archivedAreas: ReadonlySet<CheckpointArea>;
    /**
     * `providerState` is passed per call, not held: the gate is built from the
     * supervisor after the runtime starts, and the caller captures one gate for
     * one attempt. It is invoked by the publisher inside the drained window —
     * the only place where "admission is closed" is a fact rather than a hope.
     */
    takeCheckpoint(request: ManagedCheckpointRequest, options?: {
        providerState?: { prove: () => Promise<ProviderQuiescence>; stillProven: () => boolean };
    }): Promise<{
        manifest: ManagedCheckpointManifest;
        manifestDigest: string;
        pointer: ManagedCheckpointPointer;
        providerStateStillProven: boolean | null;
    }>;
};

export function createManagedCheckpointRunner(config: {
    tenant: { tenantId: string; projectId: string };
    /**
     * Asked per checkpoint, not held.
     *
     * The device uuid is what the observer found under this runtime, and it is
     * found after boot. A value captured when the runner was built would be the
     * one from before anything looked — and an archive filed against a volume
     * nobody confirmed is worse than no archive, because the restore believes
     * it.
     */
    volume: () => { volumeId: string; deviceUuid: string } | null;
    image: { imageVersion: string };
    sources: CheckpointAreaSource[];
    providerStateSessions?: readonly string[];
    /** Scratch space on the volume for the sealed objects. */
    workDir: string;
    /** How long a checkpoint may wait for in-flight writes. */
    drainBudgetMs: number;
    /** Which tools change the workspace; from the tool set actually served. */
    writeTools: ReadonlySet<string>;
    flushDeps: CheckpointFlushDeps;
    now: () => number;
    fetchImpl?: CheckpointFetch;
}): ManagedCheckpointRunner {
    const drain = createCheckpointDrain();
    return {
        checkpointDrain: { drain, writeTools: config.writeTools },
        // The sources this runner was built with — the same list it hands to
        // the publisher, so it cannot say one thing and archive another.
        archivedAreas: new Set(config.sources.map((source) => source.area)),
        async takeCheckpoint(request, options) {
            const volume = config.volume();
            if (!volume) {
                // The coordinator blocks before reaching here; this is the
                // second wall, for any other caller.
                throw new Error('managed checkpoint requires an observed volume');
            }
            // Scratch space belongs to the call, not to the runner. The sealed
            // objects are written with `O_EXCL`, so a second checkpoint
            // reaching the same directory would collide with the first one's
            // leftovers and fail for a reason that has nothing to do with it.
            const workDir = join(config.workDir, `checkpoint-${randomUUID()}`);
            await mkdir(workDir, { recursive: true, mode: 0o700 });
            try {
                const published = await publishManagedCheckpoint({
                    checkpointId: request.checkpointId,
                    tenant: config.tenant,
                    volume,
                    image: config.image,
                    sources: config.sources,
                    providerStateSessions: config.providerStateSessions,
                    // From the request, not from the runner's config: the scope
                    // belongs to this checkpoint, and the runner outlives it.
                    ...(request.providerStateScope
                        ? { providerStateScope: request.providerStateScope }
                        : {}),
                    key: request.key,
                    workDir,
                    drain,
                    drainBudgetMs: config.drainBudgetMs,
                    providerState: options?.providerState,
                    flushDeps: config.flushDeps,
                    targets: request.targets,
                    now: config.now,
                    acknowledgeUnsupportedDatabases: request.acknowledgeUnsupportedDatabases,
                    fetchImpl: config.fetchImpl,
                });
                return {
                    manifest: published.manifest,
                    manifestDigest: published.manifestDigest,
                    pointer: published.pointer,
                    providerStateStillProven: published.providerStateStillProven,
                };
            } finally {
                // The objects are on the store now, or this checkpoint failed
                // and they are worth nothing. Either way they are not the next
                // call's business.
                await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
            }
        },
    };
}
