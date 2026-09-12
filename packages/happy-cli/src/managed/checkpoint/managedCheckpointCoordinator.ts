/**
 * Drives the checkpoint runner from what the runtime is actually doing.
 *
 * The schedule decides whether it is time and the activity decides whether the
 * volume can be reasoned about; this is the part that puts those answers
 * together, calls the runner, and remembers what actually happened. Without
 * it the two would be advice nobody takes.
 *
 * Three things it is responsible for that neither half can be:
 *
 * **One attempt at a time.** The runner's drain refuses a second concurrent
 * checkpoint, but by then a tick has already asked for one and the refusal
 * looks like a failure. The in-flight flag is set before the call and cleared
 * by recording the outcome, so a tick during a checkpoint is a decision, not
 * an error.
 *
 * **A failure is a failure, and it invalidates the older success.** Anything
 * the runner throws — a full disk, a torn upload, a pointer another runtime
 * moved — leaves the saved point where it was, and `checkpointState()` stops
 * answering `saved: true`. The older checkpoint is still the newest *verified*
 * one, but a checkpoint became due and could not be taken, so the volume has
 * moved on from it: stopping on its strength discards whatever happened since.
 * Reporting the age of a checkpoint and authorising a stop are different
 * questions, and only the second one is answered here.
 *
 * **Writes since the last checkpoint invalidate it too.** The count comes from
 * the runner's own gate and nowhere else. There is no option to supply a
 * different one: the value a checkpoint is compared against is captured inside
 * that gate's drained window, so a second counter would be a different axis
 * measured against it — one that reads "always dirty" until the two numbers
 * happen to coincide, and then reads "clean" while writes are being missed.
 * When an external writer needs to be counted, it will need a contract that
 * feeds this gate rather than a number beside it.
 *
 * **A checkpoint in progress is not a saved volume.** One became due, it has
 * not landed, and it has not failed either — so neither the failure count nor
 * the write generation says anything yet.
 *
 * **A state this process did not verify proves nothing.** Resuming from a
 * persisted state says a checkpoint once succeeded; it says nothing about what
 * happened to the volume while this process was not running. It authorises a
 * stop only after this coordinator has taken one itself.
 *
 * **The targets come per attempt, and "none" is not "broken".** Signed URLs
 * expire and the key is live for one checkpoint, so they are fetched when a
 * checkpoint is actually going to happen rather than held. `null` means the
 * parent has issued none — an ordinary skip. A *throw* means the fetch failed,
 * which is a different fact: an expired signature or an unreachable control
 * plane would otherwise look exactly like an idle project, quietly, for as
 * long as it stayed broken.
 */
import type { RuntimeCheckpointState, RuntimeIdleDecision } from '@/managed/managedRuntimeActivity';

import type { ManagedCheckpointRequest, ManagedCheckpointRunner } from './managedCheckpointRunner';
import type { CheckpointAttemptEnd } from './managedCheckpointTargetInbox';
import {
    ManagedCheckpointProviderStateInvalidated,
    ManagedCheckpointProviderStateUnproven,
} from './managedCheckpointPublisher';
import type { ProviderQuiescence, ProviderQuiescenceGate } from './managedProviderQuiescence';
import {
    decideCheckpoint,
    recordCheckpointOutcome,
    type CheckpointDecision,
    type CheckpointSchedulePolicy,
    type CheckpointScheduleState,
    type CheckpointTrigger,
} from './managedCheckpointSchedule';

/**
 * The proof could not be *asked for* — a dependency of it threw.
 *
 * Carried as its own class through the publisher so the distinction survives:
 * a gate answering "not settled" is a legible state of a healthy run, while
 * this is an outage that has to engage the backoff.
 */
class CheckpointProofUnavailableError extends Error {
    constructor(readonly detail: string) {
        super(`managed checkpoint proof unavailable: ${detail}`);
        this.name = 'CheckpointProofUnavailableError';
    }
}

/** Where a checkpoint's per-attempt credentials come from. */
export type ManagedCheckpointTargetSource = {
    /** `null` when the parent has not issued targets for this runtime. */
    next: () => Promise<ManagedCheckpointRequest | null>;
    /**
     * How the attempt for a taken id ended.
     *
     * Optional because a source may hand out targets it does not track.
     *
     * Reported for every taken target, including the ones not recorded as a
     * save: an archive that published a pointer and then failed its restart
     * check has still published. A failure is reported as `uncertain` rather
     * than as "nothing happened", because this side cannot tell how far the
     * publisher got and the publisher's uploads are `ifAbsent` — a blind
     * re-run under the same id would meet its own objects.
     */
    settle?: (input: { checkpointId: string; outcome: CheckpointAttemptEnd }) => void;
};

export type CheckpointTickResult =
    | { attempted: false; decision: CheckpointDecision }
    | { attempted: false; decision: { take: false; reason: 'no-targets' } }
    | { attempted: false; decision: { take: false; reason: 'targets-unavailable'; detail: string } }
    /**
     * The proof could not be *asked for*.
     *
     * Distinct from `provider-state-unproven`, which is the gate answering no:
     * that is a legible state of a healthy run, while this is a dependency that
     * threw — `closeAdmission`, `awaitInFlight`, `endInput`, `observeExit` and
     * `writersRemaining` are all real operations that can fail. Counted as a
     * failure so the backoff engages, exactly as an unreachable target issuer
     * is, because asking again every tick would hold the runtime down.
     */
    | { attempted: false; decision: { take: false; reason: 'quiescence-unavailable'; detail: string } }
    /**
     * The provider's own state could not be proven settled.
     *
     * Neither a save nor a failure of the volume: the run is fine and the
     * checkpoint simply may not be taken yet. Recording it as a failure would
     * count it against the runtime, and recording it as a save would archive a
     * provider state nothing proved was flushed.
     */
    | { attempted: false; decision: { take: false; reason: 'provider-state-unproven'; detail: string } }
    /**
     * The volume this runtime is running on has not been observed yet.
     *
     * The device uuid comes from the observer after boot, not from the marker —
     * the marker says which volume was *attached*, the observer says which one
     * is *there*. Until they can be compared there is nothing to bind an
     * archive to, and binding it to a declared-but-unverified volume is how a
     * checkpoint ends up filed against a device the runtime never wrote to.
     */
    | { attempted: false; decision: { take: false; reason: 'volume-unobserved' } }
    | { attempted: true; saved: true; checkpointId: string }
    | { attempted: true; saved: false; detail: string };

export type ManagedCheckpointCoordinator = {
    tick(input: { trigger: CheckpointTrigger; idle: RuntimeIdleDecision; now: number }): Promise<CheckpointTickResult>;
    /** What `mayStopRuntime` needs: the last **verified** checkpoint, or none. */
    checkpointState(): RuntimeCheckpointState;
    scheduleState(): CheckpointScheduleState;
};

export function createManagedCheckpointCoordinator(config: {
    runner: ManagedCheckpointRunner;
    targets: ManagedCheckpointTargetSource;
    /**
     * Proves the provider is done writing its own state, which the tool drain
     * cannot: the provider writes as itself, outside that gate, and
     * `provider-state` is an archived area. Absent means no provider state is
     * archived on this runtime; present means a checkpoint is blocked until it
     * proves, and stays blocked rather than being recorded either way.
     */
    /**
     * Proves the provider is done writing its own state, which the tool drain
     * cannot: the provider writes as itself, outside that gate, and
     * `provider-state` is an archived area.
     *
     * **A function, and its `null` is not "no gate".** The gate is built from
     * the supervisor, which exists only after the runtime starts, so a tick
     * before then finds the reference empty. Reading that as "this runtime
     * archives no provider state" would archive state nothing proved was
     * flushed; reading it as an outage would count it against the runtime.
     * It is neither — the question cannot be asked yet, and that is what is
     * reported.
     *
     * Omitting the field entirely is a different statement: this runtime has no
     * gate at all. That is **not** permission to archive provider state — when
     * the runner archives `provider-state` and no gate exists, the attempt is
     * still refused (`no-quiescence-gate`). Omission only says nothing is
     * expected to prove; the guard on the archived area is what decides.
     */
    providerQuiescence?: () => ProviderQuiescenceGate | null;
    /**
     * The observed volume, asked per attempt.
     *
     * A function, not a value: the observer answers after boot, and a value
     * captured at construction would be the one from before it looked. `null`
     * means it still has not, which blocks rather than guessing.
     */
    volume?: () => { volumeId: string; deviceUuid: string } | null;
    /** Configured, never defaulted; `null` takes no checkpoints. */
    policy: CheckpointSchedulePolicy | null;
    initialState?: CheckpointScheduleState;
}): ManagedCheckpointCoordinator {
    let state: CheckpointScheduleState = config.initialState ?? { consecutiveFailures: 0 };
    /** The write generation the last successful checkpoint was taken at. */
    let savedAtWriteGeneration: number | null = null;
    /**
     * The gate that admitted the writes, and the same one whose drained window
     * the saved value was captured in. Anything written by another route is
     * invisible here, which is why a failed or pending attempt invalidates the
     * saved state on its own.
     */
    const writeGeneration = (): number => config.runner.checkpointDrain.drain.writes();

    /**
     * Why the checkpoint on the store is no longer evidence that **this**
     * runtime is saved, even though it was taken by this process.
     *
     * A second axis from `consecutiveFailures` on purpose. The three ways a
     * proof can be lost — refused before the archive, invalidated before the
     * pointer, or lost during the pointer's own round trip — are *not* failures
     * of the runtime and are deliberately not counted as such, so a runtime
     * whose provider restarted after a good checkpoint had
     * `consecutiveFailures === 0`, no tool writes since (the provider writes as
     * itself, outside the drain, so `writes()` does not move), and therefore
     * still answered `saved: true`. `mayStopRuntime` then authorised a stop over
     * a provider state nothing had proven was flushed.
     *
     * The checkpoint itself is kept — it is real, and it is still the newest
     * thing a restore may use. What is withdrawn is the claim that it describes
     * the volume as it is now. Cleared by the next checkpoint that lands with
     * its proof intact, never by a clock.
     */
    let currentSaveInvalidated: string | null = null;

    /**
     * Admission was closed for a checkpoint and could not be reopened.
     *
     * Sticky on purpose: the runtime cannot fix it from here, and a later
     * checkpoint that closed an already-closed admission would be building a
     * proof on a state this coordinator caused. It refuses instead of guessing.
     */
    let admissionUnreleased = false;

    /**
     * Reopens admission, at most once per attempt, and never throws.
     *
     * Every path out of a checkpoint has to run this — including the ones where
     * the proof itself failed, which is exactly where it was being skipped.
     */
    const releaseAdmission = async (gate: ProviderQuiescenceGate | null): Promise<void> => {
        /*
         * **The gate is passed in, never re-read.** The reference is late-bound,
         * so re-reading it here can hand back a different gate than the one this
         * attempt closed — and then the proof was taken on A while B is
         * reopened: A stays closed for good, and B is reopened for an attempt
         * that never closed it. One attempt, one gate, start to finish.
         */
        if (!gate) return;
        try {
            await gate.release();
        } catch {
            // The error text belongs to the runtime, not to this record. What
            // matters here is the fact, and the fact is remembered.
            admissionUnreleased = true;
        }
    };

    /** A failure's own code, or a fixed label. Never a dependency's message. */
    const codeOf = (error: unknown, fallback: string): string => {
        const code = (error as { code?: unknown } | null)?.code;
        return code === undefined ? fallback : String(code);
    };

    return {
        async tick(input) {
            const decision = decideCheckpoint({
                state,
                now: input.now,
                policy: config.policy,
                trigger: input.trigger,
                idle: input.idle,
            });
            if (!decision.take) return { attempted: false, decision };

            /*
             * Before the targets are fetched: asking the parent to sign URLs
             * for a checkpoint that cannot be bound to a volume spends a
             * credential for nothing.
             */
            if (config.volume && config.volume() === null) {
                return { attempted: false, decision: { take: false, reason: 'volume-unobserved' } };
            }

            /*
             * **Captured once, here.** The reference is late-bound; reading it
             * again later in the attempt can hand back a different gate, and
             * then the proof and the release belong to different runtimes' worth
             * of admission. Everything below — the proof, the re-check and the
             * release in `finally` — uses this one value.
             */
            const quiescence = config.providerQuiescence?.() ?? null;

            // Claimed before the first `await`. Fetching the targets yields,
            // and a tick landing in that window would find the flag unset and
            // start a second checkpoint — which the runner's drain then refuses
            // as an error rather than answering as a decision.
            state = { ...state, inFlight: true };

            /*
             * Records the outcome **without** ending the attempt.
             *
             * `recordCheckpointOutcome` clears the in-flight flag, and that flag
             * is what a concurrent tick reads. Letting it go false here would
             * hand the runtime over while the release is still on its way: the
             * next tick would close admission and observe an exit, and then this
             * attempt's release would reopen admission underneath that proof.
             *
             * So the outcome is settled here and the attempt is ended in the
             * `finally`, once the cleanup it owns has actually finished.
             */
            const recordAttempt = (outcome: Parameters<typeof recordCheckpointOutcome>[0]['outcome']): void => {
                state = { ...recordCheckpointOutcome({ state, outcome, now: input.now }), inFlight: true };
            };

            try {
                let request: ManagedCheckpointRequest | null;
                try {
                    request = await config.targets.next();
                } catch (error) {
                    // Not a skip: no checkpoint happened and the reason is a
                    // failure. Counted so the backoff engages instead of asking
                    // again every tick, and the saved point stays where it was.
                    const detail = (error as { code?: unknown })?.code === undefined
                        ? 'targets-failed'
                        : String((error as { code: unknown }).code);
                    recordAttempt({ saved: false, detail });
                    return { attempted: false, decision: { take: false, reason: 'targets-unavailable', detail } };
                }
                if (!request) {
                    // Nothing to upload to. Not a failure of the volume, and it
                    // must not be recorded as one — but no checkpoint happened.
                    return { attempted: false, decision: { take: false, reason: 'no-targets' } };
                }

                /*
                 * Proven **after** the targets are in hand and before anything is
                 * archived: the gate closes admission for its whole length, and
                 * holding it while waiting on the parent for URLs would stop the
                 * run for a request that may answer `null`.
                 */
                /*
                 * No gate, and provider state is in the archive: the checkpoint is
                 * refused rather than taken on nothing.
                 *
                 * The gate is optional because a runtime that archives only the
                 * project tree needs none — the tool drain already covers every
                 * writer of that tree. It is **not** optional for provider state,
                 * which the provider writes as itself, outside that drain. Taking
                 * the checkpoint anyway would seal a half-written state, record it
                 * as a save, and move the pointer that announces it as the latest;
                 * a restore would then believe it. So the absence of a proof is a
                 * refusal, and it stays one until something can actually prove it —
                 * an unwired gate must not be quieter than a failing one.
                 */
                /*
                 * Admission never reopened after an earlier checkpoint. Closing it
                 * again and treating that as a fresh proof would be proving nothing
                 * — the provider has been shut out since, so `closeAdmission`
                 * succeeds for a reason that has nothing to do with this attempt.
                 */
                /*
                 * The target has been taken, and every path from here to
                 * `takeCheckpoint` can still abandon the attempt. Those are the
                 * **only** endings that leave the id clean: the runner was
                 * never entered, so nothing was sealed, nothing was uploaded
                 * and no pointer moved. Once the runner has it, the id is spent
                 * whatever happens — a re-run would build a fresh IV and a new
                 * manifest timestamp, which is a different archive wearing the
                 * same name, not a recovery of the first.
                 */
                const deferBeforeStart = (): void => {
                    config.targets.settle?.({ checkpointId: request!.checkpointId, outcome: 'unstarted' });
                };

                if (admissionUnreleased) {
                    deferBeforeStart();
                    return {
                        attempted: false,
                        decision: {
                            take: false,
                            reason: 'quiescence-unavailable',
                            detail: 'admission-unreleased',
                        },
                    };
                }

                /*
                 * 참조는 있는데 게이트가 아직 없다 — supervisor 전이다. "게이트
                 * 없음" 과 다른 답이어야 한다: 전자는 증명 없이 담게 되고,
                 * 후자는 그런 runtime 이라는 뜻이다.
                 */
                if (config.providerQuiescence && quiescence === null) {
                    deferBeforeStart();
                    return {
                        attempted: false,
                        decision: {
                            take: false, reason: 'quiescence-unavailable', detail: 'gate-not-wired',
                        },
                    };
                }

                if (!config.providerQuiescence && config.runner.archivedAreas.has('provider-state')) {
                    deferBeforeStart();
                    return {
                        attempted: false,
                        decision: {
                            take: false,
                            reason: 'provider-state-unproven',
                            detail: 'no-quiescence-gate',
                        },
                    };
                }

                /*
                 * 증명은 여기서 하지 않는다 — publisher 가 drain 을 잡은 창
                 * **안에서** 한다. 증명의 첫 단계가 "admission 이 닫혔다" 이고,
                 * tool admission 을 닫는 것은 그 drain 이다. 여기서 먼저 증명하면
                 * 닫히지 않은 admission 위에서 증명한 것이 되고, 또 drain 을
                 * 두 번 잡는 순간 모든 checkpoint 가 `drain-in-progress` 로 죽는다.
                 * 이 attempt 가 잡아둔 게이트를 그 단계로 넘기고, 해제는 아래
                 * `finally` 에서 같은 게이트에 대해 한 번만 한다.
                 */
                const providerState = quiescence
                    ? {
                        prove: async (): Promise<ProviderQuiescence> => {
                            try {
                                return await quiescence.prove();
                            } catch (error) {
                                /*
                                 * 증명을 *물어보지도* 못한 것과 게이트가 아니라고
                                 * 답한 것은 다른 사건이다. 여기서 감싸 두면
                                 * publisher 를 통과해 나온 뒤에도 그 구분이 남는다.
                                 */
                                throw new CheckpointProofUnavailableError(
                                    codeOf(error, 'quiescence-failed'),
                                );
                            }
                        },
                        stillProven: () => quiescence.stillProven(),
                    }
                    : undefined;

                try {
                    const published = await config.runner.takeCheckpoint(request, { providerState });
                    /*
                     * Asked inside the drained window, by the publisher, just
                     * before it let the drain go: if a provider came back during
                     * the archive, the state that was archived is not the state
                     * that was proven — the checkpoint is not recorded as a save.
                     *
                     * Not re-asked here. After the return writers are running
                     * again, and one tool write landing in that gap would turn a
                     * checkpoint that is genuinely on the store into a refusal.
                     */
                    if (published.providerStateStillProven === false) {
                        // The archive ran and the pointer moved; only the proof
                        // did not survive it. The id is spent either way.
                        config.targets.settle?.({ checkpointId: request.checkpointId, outcome: 'published' });
                        /*
                         * pointer 는 실렸다 — 그 checkpoint 는 존재하고 restore 는
                         * 그것을 쓸 수 있다. 그러나 이 runtime 이 "저장됨" 이라고
                         * 말할 근거는 아니다. archive 도중 provider 가 다시 떴고,
                         * tool write 는 하나도 없었으므로 write 세대만 보는 검사는
                         * 이것을 절대 잡지 못한다.
                         */
                        currentSaveInvalidated = 'provider-restarted';
                        return {
                            attempted: false,
                            decision: {
                                take: false,
                                reason: 'provider-state-unproven',
                                detail: 'provider-restarted',
                            },
                        };
                    }
                    config.targets.settle?.({ checkpointId: request.checkpointId, outcome: 'published' });
                    recordAttempt({
                        saved: true,
                        checkpointId: published.pointer.checkpointId,
                        manifestDigest: published.manifestDigest,
                    });
                    // Captured inside the drained window by the gate itself, so it
                    // is the count the archive was actually taken at.
                    savedAtWriteGeneration = config.runner.checkpointDrain.drain.lastQuiescedWrites();
                    // 증명이 온전한 채로 실린 checkpoint 만 이 표식을 지운다.
                    currentSaveInvalidated = null;
                    return { attempted: true, saved: true, checkpointId: published.pointer.checkpointId };
                } catch (error) {
                    if (error instanceof ManagedCheckpointProviderStateUnproven) {
                        /*
                         * Refused inside the drained window and before the first
                         * flush, so nothing was sealed and nothing was uploaded:
                         * the id is clean and may be delivered again. Not a
                         * failure of the runtime — the run is healthy and the
                         * checkpoint simply may not be taken yet.
                         */
                        config.targets.settle?.({ checkpointId: request.checkpointId, outcome: 'unstarted' });
                        /*
                         * 이 시도는 실패가 아니지만, 예전 checkpoint 가 지금의
                         * provider state 를 설명한다는 근거도 사라졌다. 증명이
                         * 거절된 이유 그대로 남긴다.
                         */
                        currentSaveInvalidated = error.reason;
                        return {
                            attempted: false,
                            decision: {
                                take: false, reason: 'provider-state-unproven', detail: error.reason,
                            },
                        };
                    }
                    if (error instanceof ManagedCheckpointProviderStateInvalidated) {
                        /*
                         * The archive was made and then the proof stopped holding
                         * before the pointer was written — so nothing unsafe is the
                         * latest checkpoint, and the objects under this id are
                         * orphaned. `uncertain`, because they are there: a re-run
                         * under the same id would meet its own bytes.
                         *
                         * Not counted as a failure of the runtime, for the same
                         * reason a refused proof is not: the run is healthy and the
                         * checkpoint may simply not be taken yet.
                         */
                        config.targets.settle?.({ checkpointId: request.checkpointId, outcome: 'uncertain' });
                        currentSaveInvalidated = 'invalidated-during-archive';
                        return {
                            attempted: false,
                            decision: {
                                take: false,
                                reason: 'provider-state-unproven',
                                detail: 'invalidated-during-archive',
                            },
                        };
                    }
                    if (error instanceof CheckpointProofUnavailableError) {
                        /*
                         * The proof could not be asked for. Recorded as a failure
                         * so the backoff engages — asking again every tick would
                         * hold the runtime down — and the id is clean for the same
                         * reason as above.
                         */
                        config.targets.settle?.({ checkpointId: request.checkpointId, outcome: 'unstarted' });
                        recordAttempt({ saved: false, detail: error.detail });
                        return {
                            attempted: false,
                            decision: {
                                take: false, reason: 'quiescence-unavailable', detail: error.detail,
                            },
                        };
                    }
                    // Only the code is kept: a store's error text is not this
                    // runtime's to carry around.
                    const detail = (error as { code?: unknown })?.code === undefined
                        ? 'checkpoint-failed'
                        : String((error as { code: unknown }).code);
                    /*
                     * `uncertain`, not "failed": this catch cannot tell a local
                     * archive error from a torn upload or a lost pointer
                     * answer, and two of those leave bytes in the store. The
                     * safe reading is the one that does not run again by
                     * itself.
                     */
                    config.targets.settle?.({ checkpointId: request.checkpointId, outcome: 'uncertain' });
                    recordAttempt({ saved: false, detail });
                    return { attempted: true, saved: false, detail };
                }
            } finally {
                /*
                 * The one place admission is reopened, for every way out of an
                 * attempt — a refused proof, a thrown dependency, a failed
                 * archive, a provider that came back, or a checkpoint that
                 * landed. A branch that released on its own way past here would
                 * be the second claim on a lock this one still holds.
                 *
                 * It never throws: a `finally` that did would replace whatever
                 * the tick was returning, handing the caller an exception for a
                 * checkpoint already on the store.
                 *
                 * The lock is dropped after it, not before, so no tick begins
                 * while admission is still on its way open.
                 */
                await releaseAdmission(quiescence);
                // The attempt ends here and nowhere earlier: until this line the
                // runtime is still this attempt's, cleanup included.
                state = { ...state, inFlight: false };
            }
        },
        checkpointState() {
            if (state.lastSuccessAtMs === undefined
                || state.lastSuccessCheckpointId === undefined
                || state.lastSuccessManifestDigest === undefined) {
                return {
                    saved: false,
                    ...(state.lastFailureDetail === undefined ? {} : { detail: state.lastFailureDetail }),
                };
            }
            if (state.inFlight === true) {
                // Due, running, and not yet landed.
                return { saved: false, detail: 'checkpoint-in-flight' };
            }
            if (savedAtWriteGeneration === null) {
                // The success came from a state handed to this coordinator, not
                // from a checkpoint it took. Nothing here saw the volume since.
                return { saved: false, detail: 'unverified-in-this-process' };
            }
            if (currentSaveInvalidated !== null) {
                /*
                 * Checked independently of `consecutiveFailures`, because none
                 * of the three proof-loss endings is counted as a failure. The
                 * older checkpoint stays in `scheduleState()` as restore
                 * history; what it no longer is, is this runtime's current save.
                 */
                return { saved: false, detail: currentSaveInvalidated };
            }
            if (state.consecutiveFailures > 0) {
                // A checkpoint was due, was attempted, and did not happen. The
                // older one is still the newest verified checkpoint, but it is
                // no longer evidence that this volume is saved.
                return { saved: false, detail: state.lastFailureDetail ?? 'checkpoint-failed' };
            }
            if (writeGeneration() !== savedAtWriteGeneration) {
                return { saved: false, detail: 'writes-since-checkpoint' };
            }
            return {
                saved: true,
                checkpointId: state.lastSuccessCheckpointId,
                manifestDigest: state.lastSuccessManifestDigest,
            };
        },
        scheduleState: () => state,
    };
}
