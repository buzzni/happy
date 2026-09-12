/**
 * The gate a supervisor runtime hands out.
 *
 * Six of the seven things the gate observes live inside `createSupervisorRuntime`'s
 * closure — the launcher's generations, the ledger, and the means to ask those
 * generations to end their input. Nothing outside can assemble it, so the
 * runtime assembles it and the caller supplies only the drain it owns.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSupervisorRuntime } from './main';
import type { GenerationKey } from './generationManifest';
import { createCheckpointDrain } from '@/managed/checkpoint/managedCheckpointDrain';

/*
 * Hoisted, because `vi.mock`'s factory runs before the module body: the holder
 * exists when the factory is evaluated, and each test fills it.
 */
const seam = vi.hoisted(() => ({
    generations: [] as Array<{
        handle: string;
        key: { runId: string; attemptId: string; epoch: number };
        awaitGracefulStop: () => Promise<unknown>;
    }>,
    logged: [] as string[],
}));

vi.mock('./managedGenerationLaunch', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./managedGenerationLaunch')>();
    return {
        ...actual,
        createManagedGenerationLauncher: vi.fn((config: never) => ({
            // The real launcher, with only the boundaries a proof consults
            // replaced — a generation reaches `liveGenerations()` through an
            // actual launch, which this process cannot perform.
            ...actual.createManagedGenerationLauncher(config),
            closeLaunchAdmission: () => ({ closed: true, inFlight: 0 }),
            reopenLaunchAdmission: () => undefined,
            liveHandles: () => seam.generations.map((generation) => generation.handle),
            observedProviderExit: () => ({ code: 0, signal: null }),
            providerStarts: () => seam.generations.length,
            unobservableGenerations: () => 0,
            writersRemaining: async () => 0,
            ownedGenerationKeys: () => seam.generations.map((generation) => ({ ...generation.key })),
            liveGenerations: () => seam.generations.map((generation) => ({
                handle: generation.handle,
                key: { ...generation.key },
                awaitGracefulStop: generation.awaitGracefulStop,
            })),
        })),
    };
});

vi.mock('@/ui/logger', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/ui/logger')>();
    return {
        ...actual,
        logger: { ...actual.logger, debug: (line: string) => { seam.logged.push(line); } },
    };
});

/** Fixtures predate the handle; each still needs its own. */
let handleSeq = 0;

import {
    createManagedProviderQuiescenceGate,
    endInputForLiveGenerations,
} from '@/managed/checkpoint/managedProviderQuiescence';

/** What `createSupervisorRuntime`'s method builds, with its inputs in view. */
function runtimeGate(over: {
    generations?: Array<{
        handle: string;
        key: { runId: string; attemptId: string; epoch: number };
        awaitGracefulStop: (budgetMs: number) => Promise<{ stopped: boolean; detail: string }>;
    }>;
    open?: Array<{ runId: string; attemptId: string; epoch: number }>;
} = {}) {
    const owned = { runId: 'r', attemptId: 'a', epoch: 0 };
    const asked: number[] = [];
    const generations = over.generations ?? [{
        // The key the launcher assigns at creation, carried so an answer stays
        // attached to the generation that gave it.
        handle: 'h1',
        key: owned,
        awaitGracefulStop: async (budgetMs: number) => {
            asked.push(budgetMs);
            return { stopped: true, detail: 'stopped' };
        },
    }];
    const launcher = {
        closeLaunchAdmission: () => ({ closed: true, inFlight: 0 }),
        reopenLaunchAdmission: () => undefined,
        liveHandles: () => ['h1'],
        observedProviderExit: () => ({ code: 0, signal: null }),
        providerStarts: () => 1,
        unobservableGenerations: () => 0,
        writersRemaining: async () => 0,
        ownedGenerationKeys: () => [owned],
        liveGenerations: () => generations,
    };
    const gate = createManagedProviderQuiescenceGate({
        drain: { inFlight: () => 0, isDraining: () => true, writes: () => 0 },
        launcher: launcher as never,
        manifest: { listOpen: () => ({ records: over.open ?? [owned], unreadable: 0 }) },
        endInput: endInputForLiveGenerations({
            generations: () => launcher.liveGenerations(),
            budgetMs: 7_000,
        }),
    });
    return { gate, asked };
}

describe('the gate a supervisor runtime assembles from its own closure', () => {
    it('shouldProveThroughTheRuntimesOwnGenerationsAndLedger', async () => {
        const { gate, asked } = runtimeGate();
        expect(await gate.prove()).toMatchObject({ quiesced: true, exitCode: 0, signal: null });
        // The generation was actually asked, with the runtime's budget.
        expect(asked).toEqual([7_000]);
    });

    it('shouldRefuseRatherThanReturnNoGateWhenAGenerationCannotBeAsked', async () => {
        /*
         * A generation with no control channel answers `no-channel`. That is a
         * refusal the caller can read and retry — an API returning `null` here
         * would re-create the permanent "no gate" baseline instead.
         */
        const { gate } = runtimeGate({
            generations: [{
                handle: `h${handleSeq += 1}`,
                key: { runId: 'r', attemptId: 'a', epoch: 0 },
                awaitGracefulStop: async () => ({ stopped: false, detail: 'no-channel' }),
            }],
        });
        expect(await gate.prove()).toMatchObject({ quiesced: false, reason: 'eof-unverified' });
    });

    it('shouldStillConsultTheLedgerBeyondItsOwnGenerations', async () => {
        // The runtime assembling its own gate must not narrow what the gate
        // checks to what the runtime happens to own.
        const { gate } = runtimeGate({
            open: [{ runId: 'r', attemptId: 'a', epoch: 0 }, { runId: 'other', attemptId: 'x', epoch: 0 }],
        });
        expect(await gate.prove()).toMatchObject({ quiesced: false, reason: 'generation-unaccounted' });
    });
});

describe('what the runtime records about a generation it proved stopped', () => {
    /*
     * The real `createSupervisorRuntime`, its real gate, its real ledger — and the
     * production `onObserved` in `main.ts` doing the recording.
     *
     * Only the provider boundary is replaced: `createManagedGenerationLauncher` is
     * module-mocked so a generation can answer on command, because a real one
     * enters `liveGenerations()` only through an actual launch. The callback under
     * test is not mocked, and neither is the manifest — the assertions read the
     * ledger the runtime created on disk.
     *
     * `createProviderSupervisor` is untouched: the launcher options are `Omit`ed of
     * it on purpose, and that boundary is not this test's to move.
     */
    const created: string[] = [];

    const KEY = { runId: 'run-observed', attemptId: 'attempt-1', epoch: 4 };
    const SESSION = 'd6da1867-afd5-4637-bd7e-52a3e28c2fb8';
    const OTHER = '330a1f93-cda9-4080-89a3-c780c9ade479';

    function generation(
        key: GenerationKey,
        answer: { stopped: boolean; detail: string; nativeId?: string; identity?: 'conflict' },
    ) {
        return { handle: `h${handleSeq += 1}`, key, awaitGracefulStop: async () => answer };
    }

    beforeEach(() => {
        seam.generations = [];
        seam.logged.length = 0;
    });

    afterEach(() => { while (created.length) rmSync(created.pop()!, { recursive: true, force: true }); });

    function realRuntime(manifestRoot?: string) {
        const base = mkdtempSync(join(tmpdir(), 'runtime-native-'));
        created.push(base);
        return createSupervisorRuntime({
            managedRun: {
                identity: {
                    isolation: {
                        backend: 'fly-machines',
                        provider: { uid: 10601, gid: 10601 },
                        executor: { uid: 10602, gid: 10600 },
                        cgroupRoot: '/sys/fs/cgroup/saycode',
                    },
                },
                toolHelperPath: '/usr/local/lib/saycode/executor-helper',
                providerHelperPath: '/usr/local/lib/saycode/exec-helper',
                execPath: '/usr/local/lib/saycode/node',
                tools: [],
                scope: [],
                ttlMs: 60_000,
                toolTimeoutMs: 30_000,
                serverOrigin: 'https://server.invalid',
                providerEnvironment: () => ({}),
                cgroupPathFor: () => '/sys/fs/cgroup/saycode/generation',
                codexHome: '/workspace/.codex',
                onUnprovenTermination: () => undefined,
                writeFile: () => undefined,
                readProcEnviron: () => ({}),
                lstatPath: () => ({ isFile: () => true, uid: 0, gid: 0, mode: 0o755 }),
            },
            config: {
                cgroupRoot: '/sys/fs/cgroup/saycode',
                helperPath: '/usr/local/lib/saycode/exec-helper',
                workloadPath: '/usr/local/lib/saycode/node',
                resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
            },
            manifestRoot: manifestRoot ?? join(base, 'manifest'),
            stagingRoot: join(base, 'staging'),
            socketPath: join(base, 'launcher.sock'),
            watchdogIntervalMs: 1_000,
            runtimeId: `native-observation-fixture-${process.pid}`,
            releaseDeadlineMs: 2_000,
            acceptCheckpointTarget: () => ({ accepted: true }),
            acquireLock: async () => ({ ok: true, release: async () => {} }),
        } as never);
    }

    /** Drives the real gate far enough to run `endInput`, which calls the handler. */
    async function prove(runtime: ReturnType<typeof realRuntime>) {
        const drain = createCheckpointDrain();
        const gate = runtime.providerQuiescence({ drain, endInputBudgetMs: 1_000 });
        const held = await drain.drain(1_000);
        try {
            return await gate.prove();
        } finally {
            held.release();
        }
    }

    function observationFor(runtime: ReturnType<typeof realRuntime>, key: GenerationKey) {
        // All three fields: one run can hold several attempts at one epoch, and a
        // lookup missing `attemptId` would read one attempt's record as another's.
        return runtime.manifest.listAll().records
            .find((record) => record.runId === key.runId
                && record.attemptId === key.attemptId
                && record.epoch === key.epoch)
            ?.nativeObservation;
    }

    it('shouldRecordTheProvenStopAndTheSessionItNamed', async () => {
        const runtime = realRuntime();
        runtime.manifest.recordLaunch({ key: KEY, launchedAt: 1_800_000_000_000 });
        seam.generations = [generation(KEY, { stopped: true, detail: 'stopped', nativeId: SESSION })];

        await prove(runtime);

        expect(observationFor(runtime, KEY)).toMatchObject({
            outcome: 'clean-stopped', nativeId: SESSION, detail: 'stopped',
        });
        // Expected outcomes are not logged.
        expect(seam.logged.filter((line) => line.includes('native-observation'))).toEqual([]);
        await runtime.stop();
    }, 30_000);

    it('shouldRecordAProvenStopThatNamedNoSessionAsUnreported', async () => {
        const runtime = realRuntime();
        runtime.manifest.recordLaunch({ key: KEY, launchedAt: 1_800_000_000_000 });
        seam.generations = [generation(KEY, { stopped: true, detail: 'stopped' })];

        await prove(runtime);

        // Unknown identity, not "used no session".
        expect(observationFor(runtime, KEY)).toMatchObject({ outcome: 'native-unreported', nativeId: null });
        await runtime.stop();
    }, 30_000);

    it('shouldRecordTwoClaimedIdentitiesAsAConflictWithNoIdentity', async () => {
        const runtime = realRuntime();
        runtime.manifest.recordLaunch({ key: KEY, launchedAt: 1_800_000_000_000 });
        seam.generations = [generation(KEY, {
            stopped: true, detail: 'stopped', nativeId: SESSION, identity: 'conflict',
        })];

        await prove(runtime);

        expect(observationFor(runtime, KEY)).toMatchObject({ outcome: 'conflict', nativeId: null });
        await runtime.stop();
    }, 30_000);

    it.each(['timeout', 'exit-unobserved', 'still-populated'])(
        'shouldRecordNothingForTheUnprovenAnswer %s, and still record the proof that follows',
        async (detail) => {
            const runtime = realRuntime();
            runtime.manifest.recordLaunch({ key: KEY, launchedAt: 1_800_000_000_000 });
            seam.generations = [generation(KEY, { stopped: false, detail })];

            await prove(runtime);
            // "Not proven yet" is not an observation; recording it would block the
            // proof a retry brings.
            expect(observationFor(runtime, KEY)).toBeUndefined();

            seam.generations = [generation(KEY, { stopped: true, detail: 'stopped', nativeId: SESSION })];
            await prove(runtime);
            expect(observationFor(runtime, KEY)).toMatchObject({ outcome: 'clean-stopped', nativeId: SESSION });
            await runtime.stop();
        },
        30_000,
    );

    it('shouldRecordTheProvenGenerationEvenWhenAnotherRefusesAndTheCheckpointCannotProceed', async () => {
        const runtime = realRuntime();
        const refusing = { runId: 'run-refusing', attemptId: 'attempt-2', epoch: 5 };
        runtime.manifest.recordLaunch({ key: KEY, launchedAt: 1_800_000_000_000 });
        runtime.manifest.recordLaunch({ key: refusing, launchedAt: 1_800_000_000_000 });
        seam.generations = [
            generation(KEY, { stopped: true, detail: 'stopped', nativeId: SESSION }),
            generation(refusing, { stopped: false, detail: 'timeout' }),
        ];

        // The aggregate refuses — and the generation that did end that way still
        // ended that way. The observation is about it, not about the checkpoint.
        expect(await prove(runtime)).toMatchObject({ quiesced: false, reason: 'eof-unverified' });
        expect(observationFor(runtime, KEY)).toMatchObject({ outcome: 'clean-stopped', nativeId: SESSION });
        expect(observationFor(runtime, refusing)).toBeUndefined();
        await runtime.stop();
    }, 30_000);

    it('shouldReportARefusalFromTheLedgerAsAFixedCodeAndLeaveTheGateAnswerAlone', async () => {
        const runtime = realRuntime();
        // No launch record for this key: an observation must not create one.
        seam.generations = [generation(KEY, { stopped: true, detail: 'stopped', nativeId: SESSION })];

        await prove(runtime);

        expect(seam.logged).toContain('[managed] native-observation never-launched');
        expect(runtime.manifest.listAll()).toEqual({ records: [], unreadable: 0 });
        await runtime.stop();
    }, 30_000);

    it('shouldRecordTheSecondGenerationOfOneBatchWhenTheFirstWritesThrows', async () => {
        /*
         * Astra's case, and the shape matters: **one** `onObserved` call carrying
         * **two** generations. The first write throws; the handler logs one fixed
         * word, does not let it out of the callback, and still records the second.
         * Two separate proofs would pass even if the loop broke on the first
         * failure, so they would not test this at all.
         */
        const runtime = realRuntime();
        const second = { runId: 'run-second', attemptId: 'attempt-2', epoch: 6 };
        runtime.manifest.recordLaunch({ key: KEY, launchedAt: 1_800_000_000_000 });
        runtime.manifest.recordLaunch({ key: second, launchedAt: 1_800_000_000_000 });
        /*
         * The runtime returns the same manifest object `main.ts` closed over, so a
         * spy here is the writer the production handler actually calls.
         */
        const original = runtime.manifest.recordNativeObservation.bind(runtime.manifest);
        vi.spyOn(runtime.manifest, 'recordNativeObservation').mockImplementation(((input: {
            key: { runId: string };
        }) => {
            if (input.key.runId === KEY.runId) throw Object.assign(new Error('EIO'), { code: 'EIO' });
            return original(input as never);
        }) as never);

        seam.generations = [
            generation(KEY, { stopped: true, detail: 'stopped', nativeId: SESSION }),
            generation(second, { stopped: true, detail: 'stopped', nativeId: OTHER }),
        ];

        expect(await prove(runtime)).toMatchObject({ quiesced: true });
        expect(seam.logged).toContain('[managed] native-observation writer-threw');
        // Nothing of the thrower's own vocabulary reaches the log.
        expect(seam.logged.some((line) => line.includes('EIO'))).toBe(false);
        expect(observationFor(runtime, KEY)).toBeUndefined();
        expect(observationFor(runtime, second)).toMatchObject({ outcome: 'clean-stopped', nativeId: OTHER });
        await runtime.stop();
    }, 30_000);

    it('shouldStillPersistALaterProofForAGenerationWhoseFirstWriteThrew', async () => {
        const runtime = realRuntime();
        runtime.manifest.recordLaunch({ key: KEY, launchedAt: 1_800_000_000_000 });
        const original = runtime.manifest.recordNativeObservation.bind(runtime.manifest);
        let thrown = false;
        vi.spyOn(runtime.manifest, 'recordNativeObservation').mockImplementation(((input: never) => {
            if (!thrown) { thrown = true; throw Object.assign(new Error('EIO'), { code: 'EIO' }); }
            return original(input);
        }) as never);

        seam.generations = [generation(KEY, { stopped: true, detail: 'stopped', nativeId: SESSION })];
        await prove(runtime);
        expect(observationFor(runtime, KEY)).toBeUndefined();

        seam.generations = [generation(KEY, { stopped: true, detail: 'stopped', nativeId: OTHER })];
        await prove(runtime);
        expect(observationFor(runtime, KEY)).toMatchObject({ outcome: 'clean-stopped', nativeId: OTHER });
        await runtime.stop();
    }, 30_000);

    it('shouldTellApartTwoAttemptsOfOneRunAtOneEpoch, whatever order they answer in', async () => {
        /*
         * Astra's case. `runId` and `epoch` alone do not name a generation — two
         * attempts of the same run at the same epoch are two records, and the
         * answers arrive in the launcher's order, not the ledger's. Answering out
         * of order is what would expose a lookup that pairs them by anything but
         * the whole key.
         *
         * The identity is also kept as it was spelled: an id that arrives in upper
         * case is stored in upper case.
         */
        const runtime = realRuntime();
        const second = { ...KEY, attemptId: 'attempt-2' };
        runtime.manifest.recordLaunch({ key: KEY, launchedAt: 1_800_000_000_000 });
        runtime.manifest.recordLaunch({ key: second, launchedAt: 1_800_000_000_000 });
        // Reversed: the second attempt answers first.
        seam.generations = [
            generation(second, { stopped: true, detail: 'stopped', nativeId: OTHER }),
            generation(KEY, { stopped: true, detail: 'stopped', nativeId: SESSION.toUpperCase() }),
        ];

        await prove(runtime);

        expect(observationFor(runtime, KEY)?.nativeId).toBe(SESSION.toUpperCase());
        expect(observationFor(runtime, second)?.nativeId).toBe(OTHER);
        await runtime.stop();
    }, 30_000);

    it('shouldTreatTheOtherSpellingOfOneIdAsAConflictForThatAttemptAlone', async () => {
        const runtime = realRuntime();
        const second = { ...KEY, attemptId: 'attempt-2' };
        runtime.manifest.recordLaunch({ key: KEY, launchedAt: 1_800_000_000_000 });
        runtime.manifest.recordLaunch({ key: second, launchedAt: 1_800_000_000_000 });
        seam.generations = [
            generation(KEY, { stopped: true, detail: 'stopped', nativeId: SESSION.toUpperCase() }),
            generation(second, { stopped: true, detail: 'stopped', nativeId: OTHER }),
        ];
        await prove(runtime);

        // The same generation, now naming the same session in the other spelling.
        seam.generations = [generation(KEY, { stopped: true, detail: 'stopped', nativeId: SESSION })];
        await prove(runtime);

        expect(observationFor(runtime, KEY)).toMatchObject({ outcome: 'conflict', nativeId: null });
        // The attempt beside it is untouched by that contradiction.
        expect(observationFor(runtime, second)).toMatchObject({ outcome: 'clean-stopped', nativeId: OTHER });
        await runtime.stop();
    }, 30_000);

    it('shouldHaveFinishedWritingByTheTimeTheGatesAnswerResolves', async () => {
        /*
         * A statement about call order, not about durability: `onObserved` runs
         * synchronously inside `endInput()`, so the record is readable in the same
         * turn the answer resolves — no timer, no retry.
         */
        const runtime = realRuntime();
        runtime.manifest.recordLaunch({ key: KEY, launchedAt: 1_800_000_000_000 });
        seam.generations = [generation(KEY, { stopped: true, detail: 'stopped', nativeId: SESSION })];

        await prove(runtime);
        expect(observationFor(runtime, KEY)).toBeDefined();
        await runtime.stop();
    }, 30_000);
});
