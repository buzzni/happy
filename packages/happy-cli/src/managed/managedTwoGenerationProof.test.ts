/**
 * The proof has two halves that come from two different objects, and they must
 * come from the *same* provider generation.
 *
 * `gracefulStop.endedByExhaustion()` says the iterator ran out rather than
 * being aborted. `observer.exitedCleanly()` says the SDK's own process left
 * with code 0, unsignalled and unforced. The launcher creates a fresh observer
 * per loop iteration, so before `beginGeneration` existed the exhaustion was a
 * loop-global latch beside a per-generation exit — and a first generation that
 * ended its input plus a second that merely exited cleanly satisfied both.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { createManagedGracefulStop } from './managedGracefulStop';
import { createProviderExitObserver } from './managedProviderExitObserver';
import { createGenerationProofs } from './managedGenerationProof';

/**
 * The launcher's loop, reduced to what makes the proof.
 *
 * Each generation is one **record** — the observer that watched its process,
 * and whether *its* input ended. A record becomes `current` only when a real
 * process is watched, so a turn that launches nothing has nothing to read and
 * nothing that can be written into it.
 */
type Proof = { observer: ReturnType<typeof createProviderExitObserver>; inputExhausted: boolean };

function loop() {
    const stop = createManagedGracefulStop({
        queueSize: () => 0,
        hasPending: () => false,
        wake: () => undefined,
    });
    let current: Proof | null = null;
    return {
        stop,
        current: () => current,
        /** One loop iteration: a record made, installed only on a real watch. */
        iteration: (): Proof => {
            let record: Proof;
            const observer = createProviderExitObserver(() => { current = record; });
            record = { observer, inputExhausted: false };
            return record;
        },
        /** What the launcher reports on the control channel. */
        verdict: () => (current?.inputExhausted && current.observer.exitedCleanly()
            ? 'exhausted-clean'
            : current?.inputExhausted ? 'provider-exit-unclean' : 'input-not-exhausted'),
    };
}

describe('two generations cannot supply one proof between them', () => {
    it('shouldNotReuseTheFirstGenerationsExhaustionForTheSecondsCleanExit', () => {
        const run = loop();
        run.stop.request();

        // Generation 1: the input ended, but this provider was killed.
        const first = run.iteration();
        const firstChild = new EventEmitter() as EventEmitter & { killed?: boolean };
        first.observer.watch(firstChild as never);
        run.current()!.inputExhausted = true;
        firstChild.killed = true;
        firstChild.emit('exit', 0, null);
        expect(run.verdict()).toBe('provider-exit-unclean');

        // Generation 2: a clean exit, but nothing ended its input.
        const second = run.iteration();
        const secondChild = new EventEmitter();
        second.observer.watch(secondChild as never);
        secondChild.emit('exit', 0, null);

        // The two halves are from different providers. Neither generation did
        // both, so nothing may report that one did.
        expect(run.verdict()).toBe('input-not-exhausted');
    });

    it('shouldReportCleanOnlyWhenOneGenerationDidBoth', () => {
        // Positive control: without it the case above would also pass a
        // verdict that never says clean.
        const run = loop();
        run.stop.request();

        const observer = run.iteration();
        const child = new EventEmitter();
        observer.observer.watch(child as never);
        run.current()!.inputExhausted = true;
        child.emit('exit', 0, null);

        expect(run.verdict()).toBe('exhausted-clean');
    });

    it('shouldKeepThePendingStopWhileGenerationsRestart', () => {
        // A restart must not discard a stop the parent already asked for, or
        // the runtime waits for an end of input nobody will ask for again.
        const run = loop();
        run.stop.request();
        run.iteration();
        run.iteration();
        expect(run.stop.requested()).toBe(true);
    });
});

describe('a loop turn that launches nothing is not a generation', () => {
    it('shouldKeepThePreviousGenerationsProofWhenNoQueryEverStarted', () => {
        /*
         * The idle-stop path: a stop wakes `nextMessage`, `claudeRemote`
         * returns `not-started`, and no SDK process is ever spawned.
         *
         * Swapping in that turn's unused observer would report
         * `provider-exit-unclean` for a provider that had already ended its
         * input and exited cleanly — refusing a checkpoint that should have
         * been allowed. A never-started turn has no evidence of its own, and
         * it must not erase what the last real generation proved.
         */
        const run = loop();
        run.stop.request();

        // A real generation: input ended, provider left cleanly.
        const started = run.iteration();
        const child = new EventEmitter();
        started.observer.watch(child as never);
        run.current()!.inputExhausted = true;
        child.emit('exit', 0, null);
        expect(run.verdict()).toBe('exhausted-clean');

        // A turn that launches nothing. The observer is made and never used.
        run.iteration();

        expect(run.verdict()).toBe('exhausted-clean');
    });

    it('shouldStillInvalidateOnceARealQueryStarts', () => {
        // The moment a process is actually watched, the previous generation's
        // exhaustion stops answering — that is the anti-mixing rule, and it
        // must survive this fix.
        const run = loop();
        run.stop.request();

        const started = run.iteration();
        const child = new EventEmitter();
        started.observer.watch(child as never);
        run.current()!.inputExhausted = true;
        child.emit('exit', 0, null);
        expect(run.verdict()).toBe('exhausted-clean');

        const next = run.iteration();
        next.observer.watch(new EventEmitter() as never);
        expect(run.verdict()).toBe('input-not-exhausted');
    });
});

describe('the matrix an idle stop has to get right', () => {
    /** Builds a previous generation in one of the states that actually occur. */
    function previous(run: ReturnType<typeof loop>, kind: 'clean-exhausted' | 'clean-unexhausted' | 'forced-exhausted') {
        const record = run.iteration();
        const child = new EventEmitter() as EventEmitter & { killed?: boolean };
        record.observer.watch(child as never);
        if (kind !== 'clean-unexhausted') record.inputExhausted = true;
        if (kind === 'forced-exhausted') record.observer.markForced();
        child.emit('exit', 0, null);
        return record;
    }

    it.each([
        ['clean-exhausted', 'exhausted-clean'],
        ['clean-unexhausted', 'input-not-exhausted'],
        ['forced-exhausted', 'provider-exit-unclean'],
    ] as const)('shouldNotChangeA %s generation when an idle turn launches nothing', (kind, expected) => {
        /*
         * The idle-stop path calls `nextMessage` for the *initial* message,
         * before any query spawns. A turn like that must neither answer for
         * the previous generation nor rewrite it — a clean-but-unexhausted
         * exit becoming `exhausted-clean` is a proof nobody earned.
         */
        const run = loop();
        run.stop.request();
        previous(run, kind);
        expect(run.verdict()).toBe(expected);

        // The idle turn: a record is made and the initial read ends the run.
        const idle = run.iteration();
        idle.inputExhausted = true;   // what the loop does on its own record

        expect(run.verdict()).toBe(expected);
    });

    it('shouldResetOnceARealQueryStarts', () => {
        // The one thing that does replace the answer.
        const run = loop();
        run.stop.request();
        previous(run, 'clean-exhausted');
        expect(run.verdict()).toBe('exhausted-clean');

        const next = run.iteration();
        next.observer.watch(new EventEmitter() as never);
        expect(run.verdict()).toBe('input-not-exhausted');
    });
});

describe('the native identity belongs to the generation that wrote it', () => {
    const A = '11111111-2222-4333-8444-555555555555';
    const B = '66666666-7777-4888-8999-aaaaaaaaaaaa';

    /** The production record, not a model of it. */
    function watched(proofs: ReturnType<typeof createGenerationProofs>) {
        const child = new EventEmitter() as EventEmitter & { killed?: boolean };
        const record = proofs.begin((onStarted) => createProviderExitObserver(onStarted));
        record!.observer.watch(child as never);
        return { record: record!, child };
    }

    it('shouldRecordTheSessionOnTheGenerationThatFoundIt', () => {
        const proofs = createGenerationProofs();
        const first = watched(proofs);
        first.record.nativeId = A;
        expect(proofs.current()?.nativeId).toBe(A);
    });

    it('shouldIgnoreALateCallbackFromAGenerationThatHasFinished', () => {
        /*
         * The SDK reports its session asynchronously, so a callback from a
         * finished generation can arrive after the next one began. Bound to its
         * own record, it writes there and the generation being proved now keeps
         * the identity it actually wrote. A launcher-level variable would have
         * let the straggler relabel it.
         */
        const proofs = createGenerationProofs();
        const first = watched(proofs);
        const second = watched(proofs);
        second.record.nativeId = B;

        // Generation A's callback, arriving now.
        first.record.nativeId = A;

        expect(proofs.current()).toBe(second.record);
        expect(proofs.current()?.nativeId).toBe(B);
        expect(first.record.nativeId).toBe(A);
    });

    it('shouldLeaveTheCurrentGenerationAloneWhenATurnStartsNothing', () => {
        // A turn that launches no process — an idle stop waking `nextMessage`.
        // It opens no record, so there is nothing to read and nothing that can
        // be written into the generation still being proved.
        const proofs = createGenerationProofs();
        const first = watched(proofs);
        first.record.nativeId = A;
        expect(proofs.begin(() => null)).toBeNull();
        expect(proofs.current()).toBe(first.record);
        expect(proofs.current()?.nativeId).toBe(A);
    });

    it('shouldStartAFreshIdentityWhenTheSdkRestarts', () => {
        // A restart is a new generation, and it has not found its session yet.
        const proofs = createGenerationProofs();
        watched(proofs).record.nativeId = A;
        const restarted = watched(proofs);
        expect(proofs.current()).toBe(restarted.record);
        expect(proofs.current()?.nativeId).toBeNull();
    });
});
