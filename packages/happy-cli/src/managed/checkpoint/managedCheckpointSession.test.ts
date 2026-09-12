/**
 * The runtime's one checkpoint session: runner and coordinator, actually built.
 *
 * The pieces were all present and none of them met. What matters here is that
 * the composition produces **one** gate and that the coordinator drives the
 * real runner through it.
 */
import { describe, expect, it } from 'vitest';

import { createManagedCheckpointSession, managedCheckpointAreas } from './managedCheckpointSession';
import type { ManagedCheckpointRequest } from './managedCheckpointRunner';

const TENANT = { tenantId: 'co-1', projectId: 'proj-1' };
const VOLUME = { volumeId: 'vol-1', deviceUuid: 'uuid-1' };
const IMAGE = { imageVersion: 'img-1' };
const WRITE_TOOLS = new Set(['write_file', 'run_command']);

function session(over: Partial<Parameters<typeof createManagedCheckpointSession>[0]> = {}) {
    return createManagedCheckpointSession({
        tenant: TENANT,
        volume: () => VOLUME,
        image: IMAGE,
        areas: managedCheckpointAreas({
            projectRoot: '/workspace/project',
            providerStateRoot: '/workspace/.codex',
        }),
        writeTools: WRITE_TOOLS,
        drainBudgetMs: 30_000,
        flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
        targets: { next: async () => null },
        policy: null,
        ...over,
    });
}

describe('createManagedCheckpointSession', () => {
    it('shouldGiveTheWritersAndTheCheckpointTheSameGate', () => {
        const built = session();
        /*
         * Two gates on one runtime is an archive taken across a half-written
         * tree while each side is certain the volume is quiet — worse than no
         * checkpoint, because it looks like one.
         */
        expect(built.checkpointDrain).toBe(built.runner.checkpointDrain);
        expect(built.checkpointDrain.writeTools).toBe(WRITE_TOOLS);
    });

    it('shouldCoverTheProjectTreeAndTheProviderStateBesideIt', () => {
        expect(managedCheckpointAreas({
            projectRoot: '/workspace/project',
            providerStateRoot: '/workspace/.codex',
        })).toEqual([
            { area: 'project', root: '/workspace/project' },
            { area: 'provider-state', root: '/workspace/.codex' },
        ]);
    });

    it('shouldTakeNoCheckpointWhenNoPolicyWasConfigured', async () => {
        const built = session();
        const result = await built.coordinator.tick({
            trigger: 'periodic',
            idle: { idle: false, reason: 'active' } as never,
            now: 1_000,
        });
        // A runtime nobody gave a schedule to does not invent one.
        expect(result).toMatchObject({ attempted: false });
        expect(built.coordinator.checkpointState()).toMatchObject({ saved: false });
    });

    it('shouldSkipRatherThanFailWhenTheParentHasIssuedNoTargets', async () => {
        let asked = 0;
        const built = session({
            policy: { periodMs: 1, minIntervalMs: 0 } as never,
            targets: { next: async () => { asked += 1; return null; } },
        });
        const result = await built.coordinator.tick({
            trigger: 'turn-boundary',
            idle: { idle: true, reason: 'no-activity' } as never,
            now: 10_000,
        });
        expect(asked).toBe(1);
        // Nothing to upload to is not a failure of the volume — but no
        // checkpoint happened either, and the state says so.
        expect(result).toMatchObject({ attempted: false });
        expect(built.coordinator.checkpointState()).toMatchObject({ saved: false });
    });

    it('shouldCountATargetsTransportFailureAgainstTheRuntimeRatherThanSkipping', async () => {
        const built = session({
            policy: { periodMs: 1, minIntervalMs: 0 } as never,
            targets: {
                next: async () => { throw Object.assign(new Error('nope'), { code: 'targets-unavailable' }); },
            },
        });
        const result = await built.coordinator.tick({
            trigger: 'turn-boundary',
            idle: { idle: true, reason: 'no-activity' } as never,
            now: 10_000,
        });
        /*
         * "The parent issued none" and "we could not ask" are different
         * answers. Folding the second into the first reports a runtime as
         * merely un-checkpointed while its credentials are broken.
         */
        expect(result).toMatchObject({ attempted: false });
        expect(built.coordinator.checkpointState()).toMatchObject({ saved: false });
    });

    it('shouldBlockRatherThanBindAnArchiveToAVolumeNobodyHasObserved', async () => {
        let asked = 0;
        const built = session({
            policy: { periodMs: 1, minIntervalMs: 0 } as never,
            // The observer answers after boot; until it does there is nothing
            // to bind an archive to.
            volume: () => null,
            targets: { next: async () => { asked += 1; return null; } },
        });
        const result = await built.coordinator.tick({
            trigger: 'turn-boundary',
            idle: { idle: true, reason: 'no-activity' } as never,
            now: 10_000,
        });
        expect(result).toEqual({
            attempted: false, decision: { take: false, reason: 'volume-unobserved' },
        });
        // And no signed URL was spent on a checkpoint that cannot happen.
        expect(asked).toBe(0);
        expect(built.coordinator.checkpointState()).toMatchObject({ saved: false });
    });

    it('shouldRefuseInTheRunnerTooForAnyCallerThatSkipsTheCoordinator', async () => {
        const built = session({ volume: () => null });
        await expect(built.runner.takeCheckpoint({
            checkpointId: 'a'.repeat(64), key: Buffer.alloc(32, 3), targets: {} as never,
        })).rejects.toThrow(/observed volume/);
    });

    it('shouldDriveTheRealRunnerWhenTargetsAreIssued', async () => {
        const requests: ManagedCheckpointRequest[] = [];
        const built = session({
            policy: { periodMs: 1, minIntervalMs: 0 } as never,
            targets: {
                next: async () => {
                    const request = {
                        checkpointId: 'a'.repeat(64),
                        key: Buffer.alloc(32, 3),
                        targets: {} as never,
                    };
                    requests.push(request);
                    return request;
                },
            },
        });
        await built.coordinator.tick({
            trigger: 'turn-boundary',
            idle: { idle: true, reason: 'no-activity' } as never,
            now: 10_000,
        });
        // The coordinator asked for targets and handed them to the runner —
        // the real one, which then fails on the empty targets rather than
        // being stubbed out.
        expect(requests).toHaveLength(1);
        expect(built.coordinator.checkpointState()).toMatchObject({ saved: false });
    });
});
