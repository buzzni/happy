/**
 * The provider is not quiet because nothing looked.
 *
 * Each case here is a way a checkpoint could have called provider state settled
 * without it being settled — and every one of them must block instead.
 */
import { describe, expect, it } from 'vitest';

/** Fixtures predate the handle; each still needs its own. */
let handleSeq = 0;

import {
    createManagedProviderQuiescenceGate,
    endInputForLiveGenerations,
    createProviderQuiescenceGate,
    proveProviderQuiescence,
    type ProviderQuiescenceDeps,
} from './managedProviderQuiescence';

function deps(over: Partial<ProviderQuiescenceDeps> = {}): ProviderQuiescenceDeps {
    return {
        closeAdmission: async () => ({ closed: true, inFlight: 0 }),
        awaitInFlight: async () => ({ drained: true }),
        endInput: async () => ({ eof: true }),
        observeExit: async () => ({ code: 0, signal: null }),
        writersRemaining: async () => 0,
        providerStarts: () => 1,
        unobservableGenerations: () => 0,
        ...over,
    };
}

describe('proveProviderQuiescence', () => {
    it('shouldProveItOnlyWhenTheWholeSequenceHeld', async () => {
        expect(await proveProviderQuiescence(deps()))
            .toMatchObject({ quiesced: true, exitCode: 0, signal: null });
    });

    it('shouldRefuseWhileNewWorkCouldStillBeAdmitted', async () => {
        expect(await proveProviderQuiescence(deps({
            closeAdmission: async () => ({ closed: false, inFlight: 0 }),
        }))).toMatchObject({ quiesced: false, reason: 'admission-open' });
    });

    it('shouldRefuseWhileWorkAdmittedBeforeTheCloseIsStillRunning', async () => {
        expect(await proveProviderQuiescence(deps({
            awaitInFlight: async () => ({ drained: false }),
        }))).toMatchObject({ quiesced: false, reason: 'work-in-flight' });
    });

    it('shouldRefuseWhenTheProviderWasNeverDrivenToANormalEndOfInput', async () => {
        expect(await proveProviderQuiescence(deps({
            endInput: async () => ({ eof: false }),
        }))).toMatchObject({ quiesced: false, reason: 'eof-unverified' });
    });

    it('shouldRefuseWhenNothingObservedTheChildLeaving', async () => {
        /*
         * Claude Agent SDK 0.3.179's `waitForExit()` returns as soon as
         * `process.killed` is set — which Node does on signal delivery, not on
         * death. A checkpoint that trusted it would archive while the provider
         * was still writing.
         */
        expect(await proveProviderQuiescence(deps({
            observeExit: async () => null,
        }))).toMatchObject({ quiesced: false, reason: 'exit-unobserved' });
    });

    it('shouldRefuseAKilledProviderRatherThanCallItANonZeroExit', async () => {
        /*
         * Codex `disconnect()` sends SIGTERM and then SIGKILL after two
         * seconds. A killed provider did not flush, and reporting that as
         * `exit-nonzero` would hide which of the two happened.
         */
        expect(await proveProviderQuiescence(deps({
            observeExit: async () => ({ code: 137, signal: 'SIGKILL' }),
        }))).toMatchObject({ quiesced: false, reason: 'exit-signalled' });
    });

    it('shouldRefuseAnUncleanExit', async () => {
        expect(await proveProviderQuiescence(deps({
            observeExit: async () => ({ code: 1, signal: null }),
        }))).toMatchObject({ quiesced: false, reason: 'exit-nonzero' });
    });

    it('shouldRefuseWhileAnythingStillHoldsTheProvidersStateOpen', async () => {
        expect(await proveProviderQuiescence(deps({
            writersRemaining: async () => 1,
        }))).toMatchObject({ quiesced: false, reason: 'writers-remain' });
    });

    it('shouldRefuseWhenAProviderStartedAgainDuringTheSequence', async () => {
        let starts = 1;
        expect(await proveProviderQuiescence(deps({
            providerStarts: () => starts,
            // A restart lands while the exit is being observed.
            observeExit: async () => { starts = 2; return { code: 0, signal: null }; },
        }))).toMatchObject({ quiesced: false, reason: 'provider-restarted' });
    });
});

describe('createProviderQuiescenceGate', () => {
    it('shouldStopBeingProvenTheMomentAProviderStartsAgain', async () => {
        let starts = 1;
        const gate = createProviderQuiescenceGate({
            ...deps({ providerStarts: () => starts }),
            reopenAdmission: async () => undefined,
        });

        expect((await gate.prove()).quiesced).toBe(true);
        expect(gate.stillProven()).toBe(true);

        /*
         * `publishManagedCheckpoint` releases the tool drain in its `finally`,
         * so a stop that trusted its return would be racing writers that had
         * already resumed. This gate is asked again at the pointer write, not
         * remembered from before the archive.
         */
        starts = 2;
        expect(gate.stillProven()).toBe(false);
    });

    it('shouldNotBeProvenAfterARefusal', async () => {
        const gate = createProviderQuiescenceGate({
            ...deps({ endInput: async () => ({ eof: false }) }),
            reopenAdmission: async () => undefined,
        });
        expect(await gate.prove()).toMatchObject({ quiesced: false });
        expect(gate.stillProven()).toBe(false);
    });

    it('shouldStopBeingProvenOnceAdmissionIsReopened', async () => {
        let reopened = 0;
        const gate = createProviderQuiescenceGate({
            ...deps(),
            reopenAdmission: async () => { reopened += 1; },
        });
        await gate.prove();
        await gate.release();
        expect(reopened).toBe(1);
        expect(gate.stillProven()).toBe(false);
    });
});

describe('generations this runtime cannot answer for', () => {
    it('shouldRefuseWhileAGenerationItCannotObserveIsStillLive', async () => {
        /*
         * A generation reconciled from a previous runtime, or one kept alive
         * by a failed stop, has no run left to ask. Its silence looks exactly
         * like quiet, and the rest of the sequence would pass on the strength
         * of a provider nobody is watching.
         */
        expect(await proveProviderQuiescence(deps({ unobservableGenerations: () => 1 })))
            .toMatchObject({ quiesced: false, reason: 'generation-unaccounted' });
    });

    it('shouldRefuseEvenWhenEverythingElseWouldHaveHeld', async () => {
        // The default deps are the fully-quiescent ones, so this is the same
        // sequence that returns proof above, differing only in this axis.
        const outcome = await proveProviderQuiescence(deps({ unobservableGenerations: () => 2 }));
        expect(outcome).toMatchObject({ quiesced: false });
    });

    it('shouldAskAgainRatherThanRememberWhenOneAppearsAfterTheProof', async () => {
        /*
         * The proof is taken before the archive and relied on until the
         * pointer is written. A generation reconciled during that window is
         * exactly the case `stillProven` exists for — `providerStarts` will
         * not move for it, because this runtime never launched it.
         */
        let unobservable = 0;
        const gate = createProviderQuiescenceGate({
            ...deps({ unobservableGenerations: () => unobservable }),
            reopenAdmission: async () => undefined,
        });

        expect((await gate.prove()).quiesced).toBe(true);
        expect(gate.stillProven()).toBe(true);

        unobservable = 1;
        expect(gate.stillProven()).toBe(false);
    });
});

describe('an exit that arrives late', () => {
    it('shouldRefuseRatherThanWaitWhenTheChildHasNotBeenSeenToLeave', async () => {
        /*
         * `observeExit` reports what was seen; it does not block. A gate that
         * waited would let one provider that never ends stop the whole
         * runtime from ever checkpointing.
         */
        expect(await proveProviderQuiescence(deps({ observeExit: async () => null })))
            .toMatchObject({ quiesced: false, reason: 'exit-unobserved' });
    });

    it('shouldNotTurnAnEarlierRefusalIntoAProofWhenTheExitArrivesAfterwards', async () => {
        // The refusal is not cached and the late exit is not backdated: the
        // next proof runs the whole sequence again against what is true then.
        let exit: { code: number | null; signal: string | null } | null = null;
        const gate = createProviderQuiescenceGate({
            ...deps({ observeExit: async () => exit }),
            reopenAdmission: async () => undefined,
        });

        expect(await gate.prove()).toMatchObject({ quiesced: false, reason: 'exit-unobserved' });
        expect(gate.stillProven()).toBe(false);

        exit = { code: 0, signal: null };
        expect((await gate.prove()).quiesced).toBe(true);
        expect(gate.stillProven()).toBe(true);
    });

    it('shouldNeverCallASignalledExitAFlush', async () => {
        // A late exit that arrived because something killed it is the case
        // most likely to be mistaken for a clean end.
        expect(await proveProviderQuiescence(deps({
            observeExit: async () => ({ code: 137, signal: 'SIGKILL' }),
        }))).toMatchObject({ quiesced: false, reason: 'exit-signalled' });
    });
});

describe('the gate a running runtime actually assembles', () => {
    /** A launcher and a drain that each answer honestly, and are asked. */
    function runtime(over: {
        launcher?: Record<string, unknown>;
        drain?: Record<string, unknown>;
        manifest?: { records: Array<{ runId: string; attemptId: string; epoch: number }>; unreadable: number };
        endInput?: () => Promise<{ eof: boolean }>;
    } = {}) {
        const calls: string[] = [];
        let writes = 0;
        // The proof is taken with the drain already held — see ORDERING.md.
        let draining = true;
        const gate = createManagedProviderQuiescenceGate({
            drain: {
                inFlight: () => { calls.push('in-flight'); return 0; },
                isDraining: () => { calls.push('is-draining'); return draining; },
                writes: () => { calls.push('writes'); return writes; },
                ...over.drain,
            } as never,
            launcher: {
                closeLaunchAdmission: () => { calls.push('close-launch'); return { closed: true, inFlight: 0 }; },
                reopenLaunchAdmission: () => { calls.push('reopen-launch'); },
                liveHandles: () => ['h1'],
                observedProviderExit: () => ({ code: 0, signal: null }),
                providerStarts: () => 1,
                unobservableGenerations: () => 0,
                writersRemaining: async () => { calls.push('writers'); return 0; },
                ownedGenerationKeys: () => [{ runId: 'r', attemptId: 'a', epoch: 0 }],
                ...over.launcher,
            } as never,
            /*
             * One open record by default, matching the one live handle below:
             * a generation this launcher owns is open in the manifest until
             * its termination is observed.
             */
            manifest: {
                listOpen: () => over.manifest
                    ?? { records: [{ runId: 'r', attemptId: 'a', epoch: 0 }], unreadable: 0 },
            },
            endInput: over.endInput ?? (async () => ({ eof: true })),
        });
        return {
            gate,
            calls,
            write: () => { writes += 1; },
            reopenTools: () => { draining = false; },
        };
    }

    it('shouldProveQuiescenceOnlyWhenEveryRealSourceAgreed', async () => {
        const { gate, calls } = runtime();
        expect(await gate.prove()).toMatchObject({ quiesced: true, exitCode: 0, signal: null });
        // Each source was actually asked, not assumed.
        expect(calls).toContain('close-launch');
        expect(calls).toContain('in-flight');
        expect(calls).toContain('writers');
    });

    it('shouldRefuseWhenToolAdmissionIsNotActuallyClosed', async () => {
        /*
         * The gate closes launch admission, not tool admission. Reporting
         * `closed: true` while `beginWrite()` is still accepted would claim an
         * exclusion it does not have, and the proof would describe a volume
         * that could still be written.
         */
        const { gate, reopenTools } = runtime();
        reopenTools();
        expect(await gate.prove()).toMatchObject({ quiesced: false, reason: 'admission-open' });
    });

    it('shouldNeverAcquireTheDrainThePublisherOwns', async () => {
        /*
         * `publishManagedCheckpoint` drains for the length of the archive. A
         * gate that also drained would make the publisher's call find one in
         * progress, and every real checkpoint would fail. The gate reads the
         * drain and never takes it.
         */
        const { gate, calls } = runtime();
        await gate.prove();
        expect(calls).not.toContain('drain');
        expect(calls).toContain('in-flight');
    });

    it('shouldRefuseWhileAToolWriteIsStillRunning', async () => {
        // `work-in-flight`, not `admission-open`: admission did close — the
        // launch half is this gate's to close — and what is outstanding is a
        // write that was admitted before it.
        const { gate } = runtime({ drain: { inFlight: () => 1, isDraining: () => true, writes: () => 0 } });
        expect(await gate.prove()).toMatchObject({ quiesced: false, reason: 'work-in-flight' });
    });

    it('shouldStopBeingProvenOnceAnythingIsWrittenAfterTheProof', async () => {
        // The window between the proof and the publisher's own drain. A write
        // that lands in it means the archive would not describe what was
        // proven.
        const { gate, write } = runtime();
        expect((await gate.prove()).quiesced).toBe(true);
        expect(gate.stillProven()).toBe(true);

        write();
        expect(gate.stillProven()).toBe(false);
    });

    it('shouldRefuseWhileAnyLiveGenerationHasNotBeenSeenToLeave', async () => {
        // Provider state is archived whole. One generation nobody saw leave is
        // a writer nobody watched, however quiet the others were.
        const { gate } = runtime({
            launcher: {
                liveHandles: () => ['h1', 'h2'],
                observedProviderExit: (handle: string) =>
                    (handle === 'h1' ? { code: 0, signal: null } : null),
            },
        });
        expect(await gate.prove()).toMatchObject({ quiesced: false, reason: 'exit-unobserved' });
    });

    it.each([['clean', 'killed'], ['killed', 'clean']])(
        'shouldReportASignalledGenerationWhicheverSideOfACleanOneItIsOn(%s,%s)',
        async (first, second) => {
            /*
             * Both orders, because one order alone passes an implementation
             * that merely returns the last exit it looked at — which would
             * report the clean one and archive a killed provider's state.
             */
            const { gate } = runtime({
                launcher: {
                    liveHandles: () => [first, second],
                    observedProviderExit: (handle: string) => (handle === 'clean'
                        ? { code: 0, signal: null }
                        : { code: 137, signal: 'SIGKILL' }),
                },
            });
            expect(await gate.prove()).toMatchObject({ quiesced: false, reason: 'exit-signalled' });
        },
    );

    it('shouldRefuseWhenTheProviderWasNeverDrivenToAnEndOfInput', async () => {
        // The dep this runtime cannot yet supply. A gate handed a fabricated
        // `true` here would return proof for a provider nobody ended.
        const { gate } = runtime({ endInput: async () => ({ eof: false }) });
        expect(await gate.prove()).toMatchObject({ quiesced: false, reason: 'eof-unverified' });
    });

    it('shouldReadmitGenerationsWhenTheGateIsReleased', async () => {
        const { gate, calls } = runtime();
        await gate.prove();
        await gate.release();
        expect(calls).toContain('reopen-launch');
        expect(gate.stillProven()).toBe(false);
    });
});

const OWNED = { runId: 'r', attemptId: 'a', epoch: 0 };
const OTHER = { runId: 'r2', attemptId: 'a2', epoch: 0 };

describe('generations open beyond the launcher that owns them', () => {
    /*
     * Astra's correction. `unobservableGenerations` on the launcher scans its
     * own map, and `main.reconcile` handles a generation left by a previous
     * runtime straight off the manifest without ever inserting it there. So
     * the launcher's number is not runtime-wide coverage, and a factory that
     * used it alone would report every generation accounted for while one from
     * before the restart was still open.
     */
    function withManifest(manifest: {
        records: Array<{ runId: string; attemptId: string; epoch: number }>;
        unreadable: number;
    }) {
        const calls: string[] = [];
        return createManagedProviderQuiescenceGate({
            drain: { inFlight: () => 0, isDraining: () => true, writes: () => 0 } as never,
            launcher: {
                closeLaunchAdmission: () => ({ closed: true, inFlight: 0 }),
                reopenLaunchAdmission: () => { calls.push('reopen'); },
                liveHandles: () => ['h1'],
                observedProviderExit: () => ({ code: 0, signal: null }),
                providerStarts: () => 1,
                unobservableGenerations: () => 0,
                writersRemaining: async () => 0,
                ownedGenerationKeys: () => [OWNED],
            } as never,
            manifest: { listOpen: () => manifest },
            endInput: async () => ({ eof: true }),
        });
    }

    it('shouldProveWhenTheOnlyOpenRecordIsTheGenerationThisLauncherOwns', async () => {
        // Positive control: the open record is the owned generation itself.
        expect((await withManifest({ records: [OWNED], unreadable: 0 }).prove()).quiesced).toBe(true);
    });

    it('shouldRefuseWhenTheManifestHoldsAGenerationThisLauncherIsNotAnsweringFor', async () => {
        // Two open, one of them owned: the other is reconciled or abandoned,
        // and nothing here can observe it leaving.
        expect(await withManifest({ records: [OWNED, OTHER], unreadable: 0 }).prove())
            .toMatchObject({ quiesced: false, reason: 'generation-unaccounted' });
    });

    it('shouldRefuseWhenTheOpenSetAndTheOwnedSetAreDisjoint', async () => {
        /*
         * Astra's case, and the one a size comparison gets wrong.
         * `recordTermination` closes a generation's record before its broker
         * is closed, and a close that fails keeps it owned for good — so the
         * owned generation can be absent from the open set while an unrelated
         * generation is present in it. One open, one owned, nothing in common:
         * subtraction says zero and this must say one.
         */
        expect(await withManifest({ records: [OTHER], unreadable: 0 }).prove())
            .toMatchObject({ quiesced: false, reason: 'generation-unaccounted' });
    });

    it('shouldTellTwoGenerationsApartByEveryPartOfTheirIdentity', async () => {
        // Same run and attempt, next epoch. A restart of the same attempt is
        // a different generation and is not covered by the one before it.
        const nextEpoch = { ...OWNED, epoch: OWNED.epoch + 1 };
        expect(await withManifest({ records: [nextEpoch], unreadable: 0 }).prove())
            .toMatchObject({ quiesced: false, reason: 'generation-unaccounted' });
    });

    it('shouldRefuseWhenARecordCouldNotBeRead', async () => {
        // The one case where the runtime cannot even say what it does not
        // know. Counting it as covered is the worst available answer.
        expect(await withManifest({ records: [OWNED], unreadable: 1 }).prove())
            .toMatchObject({ quiesced: false, reason: 'generation-unaccounted' });
    });

    it('shouldStopBeingProvenWhenAGenerationAppearsInTheManifestAfterTheProof', async () => {
        let open = { records: [OWNED], unreadable: 0 };
        const calls: string[] = [];
        const gate = createManagedProviderQuiescenceGate({
            drain: { inFlight: () => 0, isDraining: () => true, writes: () => 0 } as never,
            launcher: {
                closeLaunchAdmission: () => ({ closed: true, inFlight: 0 }),
                reopenLaunchAdmission: () => { calls.push('reopen'); },
                liveHandles: () => ['h1'],
                observedProviderExit: () => ({ code: 0, signal: null }),
                providerStarts: () => 1,
                unobservableGenerations: () => 0,
                writersRemaining: async () => 0,
                ownedGenerationKeys: () => [OWNED],
            } as never,
            manifest: { listOpen: () => open },
            endInput: async () => ({ eof: true }),
        });

        expect((await gate.prove()).quiesced).toBe(true);
        expect(gate.stillProven()).toBe(true);

        // A reconciled generation never moves `providerStarts`, so this is
        // the only thing that can catch it inside the archive window.
        open = { records: [OWNED, OTHER], unreadable: 0 };
        expect(gate.stillProven()).toBe(false);
    });
});

describe('the real endInput, over the control descriptor', () => {
    function generations(...stopped: boolean[]) {
        const asked: number[] = [];
        return {
            asked,
            endInput: endInputForLiveGenerations({
                budgetMs: 1_000,
                generations: () => stopped.map((ok, index) => ({
                    handle: `h-${index}`,
                    key: { runId: `r-${index}`, attemptId: `a-${index}`, epoch: 0 },
                    awaitGracefulStop: async () => { asked.push(index); return { stopped: ok }; },
                })),
            }),
        };
    }

    it('shouldEndInputWhenEveryLiveGenerationStopped', async () => {
        const { endInput, asked } = generations(true, true);
        expect(await endInput()).toMatchObject({ eof: true });
        // Every one of them was actually asked.
        expect(asked.sort()).toEqual([0, 1]);
    });

    it('shouldCarryTheReasonAGenerationGaveRatherThanSwallowingIt', async () => {
        /*
         * `endInput` can only answer true or false, so every reason was lost
         * here and the gate could say no more than `eof-unverified` — the
         * step, not the cause. Three live runs were spent deducing what this
         * line would have said outright.
         */
        const seen: string[] = [];
        const endInput = endInputForLiveGenerations({
            budgetMs: 1_000,
            generations: () => [{
                handle: 'h-0',
                key: { runId: 'r', attemptId: 'a', epoch: 0 },
                awaitGracefulStop: async () => ({ stopped: false, detail: 'exit-unobserved' }),
            }],
            onRefused: (detail) => { seen.push(detail); },
        });

        expect(await endInput()).toMatchObject({ eof: false });
        expect(seen).toEqual(['exit-unobserved']);
    });

    it('shouldReportAClosedCodeEvenWhenAGenerationInventsOne', async () => {
        // This reaches a log the parent may read. A generation's own string is
        // not the daemon's to echo.
        const seen: string[] = [];
        await endInputForLiveGenerations({
            budgetMs: 1_000,
            generations: () => [{
                handle: 'h-0',
                key: { runId: 'r', attemptId: 'a', epoch: 0 },
                awaitGracefulStop: async () => ({ stopped: false, detail: '/workspace/secret path' }),
            }],
            onRefused: (detail) => { seen.push(detail); },
        })();
        expect(seen).toEqual(['unknown']);
    });

    it('shouldSayNothingWhenEveryGenerationStopped', async () => {
        const seen: string[] = [];
        await endInputForLiveGenerations({
            budgetMs: 1_000,
            generations: () => [{ handle: `h${handleSeq += 1}`, key: { runId: 'r', attemptId: 'a', epoch: 0 }, awaitGracefulStop: async () => ({ stopped: true, detail: 'stopped' }) }],
            onRefused: (detail) => { seen.push(detail); },
        })();
        expect(seen).toEqual([]);
    });

    it('shouldRefuseWhenAnyOneGenerationDidNotStop', async () => {
        // Provider state is archived whole. One generation that did not end
        // is one that may still be writing.
        expect(await generations(true, false).endInput()).toMatchObject({ eof: false });
    });

    it('shouldAskEveryGenerationRatherThanStoppingAtTheFirstRefusal', async () => {
        // A generation left un-asked keeps accepting input while the others
        // are ending.
        const { endInput, asked } = generations(false, true, true);
        expect(await endInput()).toMatchObject({ eof: false });
        expect(asked.length).toBe(3);
    });

    it('shouldNotTreatNoGenerationsAsSomethingThatFailed', async () => {
        // Nothing to end. What follows — the exit and writer checks — decides.
        expect(await generations().endInput()).toMatchObject({ eof: true });
    });
});

describe('what each generation said as it ended, kept per generation', () => {
    const A = 'aabbccdd-11ee-4ff1-8abc-def123456789';
    const B = '99887766-55aa-4bb3-8ccd-eeff00112233';

    const generation = (handle: string, answer: Record<string, unknown>) => ({
        handle,
        key: { runId: `run-${handle}`, attemptId: `attempt-${handle}`, epoch: 0 },
        awaitGracefulStop: async () => answer as never,
    });

    it('shouldKeepEachGenerationsAnswerAgainstItsOwnHandle', async () => {
        /*
         * Per generation, keyed by the handle the launcher assigned when it
         * created the entry. Not zipped against `ownedGenerationKeys()`: that is
         * a different population — a generation whose manifest record is closed
         * is still owned there while having no run to speak to — so pairing the
         * two by position would attach one generation's answer to another's
         * identity.
         */
        const observations: unknown[] = [];
        const endInput = endInputForLiveGenerations({
            budgetMs: 1_000,
            generations: () => [
                generation('h-1', { stopped: true, detail: 'stopped', nativeId: A }),
                generation('h-2', { stopped: true, detail: 'stopped', nativeId: B }),
            ],
            onObserved: (seen) => { observations.push(...seen); },
        });
        expect(await endInput()).toMatchObject({ eof: true });
        expect(observations).toEqual([
            { handle: 'h-1', key: { runId: 'run-h-1', attemptId: 'attempt-h-1', epoch: 0 }, stopped: true, detail: 'stopped', nativeId: A, identity: null },
            { handle: 'h-2', key: { runId: 'run-h-2', attemptId: 'attempt-h-2', epoch: 0 }, stopped: true, detail: 'stopped', nativeId: B, identity: null },
        ]);
    });

    it('shouldKeepTheAnswerOfAGenerationThatNamedNothing', async () => {
        // Absent is an observation. Dropping it leaves the publisher unable to
        // tell "nobody said" from "nothing was asked".
        const observations: unknown[] = [];
        await endInputForLiveGenerations({
            budgetMs: 1_000,
            generations: () => [generation('h-1', { stopped: true, detail: 'stopped' })],
            onObserved: (seen) => { observations.push(...seen); },
        })();
        expect(observations).toEqual([
            { handle: 'h-1', key: { runId: 'run-h-1', attemptId: 'attempt-h-1', epoch: 0 }, stopped: true, detail: 'stopped', nativeId: null, identity: null },
        ]);
    });

    it('shouldKeepAConflictAsAConflictRatherThanAsSilence', async () => {
        const observations: unknown[] = [];
        await endInputForLiveGenerations({
            budgetMs: 1_000,
            // It named one *and* contradicted itself. The id must not survive
            // that: an id blessed by a pair the child does not agree on is not
            // an identity, and a fixture that named nothing would prove nothing.
            generations: () => [generation('h-1', {
                stopped: true, detail: 'stopped', nativeId: A, identity: 'conflict',
            })],
            onObserved: (seen) => { observations.push(...seen); },
        })();
        expect(observations).toEqual([
            { handle: 'h-1', key: { runId: 'run-h-1', attemptId: 'attempt-h-1', epoch: 0 }, stopped: true, detail: 'stopped', nativeId: null, identity: 'conflict' },
        ]);
    });

    it('shouldKeepTheAnswerOfAGenerationThatRefusedToEnd', async () => {
        // A refusal is the most informative observation there is, and it used to
        // be the one that disappeared.
        const observations: unknown[] = [];
        const endInput = endInputForLiveGenerations({
            budgetMs: 1_000,
            generations: () => [
                generation('h-1', { stopped: true, detail: 'stopped', nativeId: A }),
                generation('h-2', { stopped: false, detail: 'exit-unclean', nativeId: B }),
            ],
            onObserved: (seen) => { observations.push(...seen); },
        });
        expect(await endInput()).toMatchObject({ eof: false });
        expect(observations).toEqual([
            { handle: 'h-1', key: { runId: 'run-h-1', attemptId: 'attempt-h-1', epoch: 0 }, stopped: true, detail: 'stopped', nativeId: A, identity: null },
            { handle: 'h-2', key: { runId: 'run-h-2', attemptId: 'attempt-h-2', epoch: 0 }, stopped: false, detail: 'exit-unclean', nativeId: B, identity: null },
        ]);
    });

    it('shouldNotCarryAGenerationsOwnTextInTheObservation', async () => {
        // The observation travels further than the refusal log does, so the
        // closed vocabulary has to be applied before it is recorded, not only
        // on the way to `onRefused`.
        const observations: unknown[] = [];
        await endInputForLiveGenerations({
            budgetMs: 1_000,
            generations: () => [generation('h-1', { stopped: false, detail: '/workspace/secret path' })],
            onObserved: (seen) => { observations.push(...seen); },
        })();
        expect(observations).toEqual([
            { handle: 'h-1', key: { runId: 'run-h-1', attemptId: 'attempt-h-1', epoch: 0 }, stopped: false, detail: 'unknown', nativeId: null, identity: null },
        ]);
    });

    it('shouldKeepTheKeyTheGenerationHadWhenItWasAsked', async () => {
        /*
         * The key is read before the await and held across it, so an entry
         * replaced while the generation was answering cannot rewrite an answer
         * already given. Sharing the launcher's object instead of copying it
         * would let exactly that happen, silently and long after the fact.
         */
        const mutable = { runId: 'run-asked', attemptId: 'attempt-asked', epoch: 1 };
        const observations: unknown[] = [];
        await endInputForLiveGenerations({
            budgetMs: 1_000,
            generations: () => [{
                handle: 'h-1',
                key: mutable,
                awaitGracefulStop: async () => {
                    // The entry moves on while this generation is still answering.
                    mutable.runId = 'run-next';
                    mutable.epoch = 2;
                    return { stopped: true, detail: 'stopped', nativeId: A };
                },
            }],
            onObserved: (seen) => { observations.push(...seen); },
        })();
        expect(observations).toEqual([{
            handle: 'h-1',
            key: { runId: 'run-asked', attemptId: 'attempt-asked', epoch: 1 },
            stopped: true,
            detail: 'stopped',
            nativeId: A,
            identity: null,
        }]);
    });

    it('shouldCarryTheObservationsOutOfTheProofItself', async () => {
        /*
         * The proof is what the publisher receives inside the held drain, so
         * that is where the observations have to arrive. Anything read from a
         * getter in the publisher's arguments is read before the drain is even
         * acquired — `managedCheckpointRunner.ts:129` builds them, the publisher
         * takes the drain at `:249` and only calls `prove()` at `:257`.
         */
        const proof = await proveProviderQuiescence({
            ...deps(),
            endInput: endInputForLiveGenerations({
                budgetMs: 1_000,
                generations: () => [generation('h-1', { stopped: true, detail: 'stopped', nativeId: A })],
            }),
        });
        expect(proof).toMatchObject({
            quiesced: true,
            providerState: {
                completeness: 'history-unestablished',
                generations: [{ handle: 'h-1', nativeId: A, identity: null, stopped: true }],
            },
        });
    });

    it('shouldSayHistoryIsUnestablishedEvenWhenTheIdentityIsPerfect', async () => {
        /*
         * Completeness is not freshness. A clean generation with a clean id
         * still says nothing about earlier attempts this project needs to be
         * restorable, and there is no arm of this type that claims otherwise —
         * a state nothing can reach is a state nobody can test.
         */
        const proof = await proveProviderQuiescence({
            ...deps(),
            endInput: endInputForLiveGenerations({
                budgetMs: 1_000,
                generations: () => [generation('h-1', { stopped: true, detail: 'stopped', nativeId: A })],
            }),
        });
        expect(proof.quiesced && proof.providerState?.completeness).toBe('history-unestablished');
    });

    it('shouldObserveAfreshOnASecondTickRatherThanRememberTheFirst', async () => {
        let answer: Record<string, unknown> = { stopped: true, detail: 'stopped', nativeId: A };
        const endInput = endInputForLiveGenerations({
            budgetMs: 1_000,
            generations: () => [generation('h-1', answer)],
        });
        const first = await proveProviderQuiescence({ ...deps(), endInput });
        expect(first.quiesced && first.providerState?.generations[0]?.nativeId).toBe(A);

        answer = { stopped: true, detail: 'stopped' };
        const second = await proveProviderQuiescence({ ...deps(), endInput });
        expect(second.quiesced && second.providerState?.generations[0]?.nativeId).toBeNull();
    });
});
