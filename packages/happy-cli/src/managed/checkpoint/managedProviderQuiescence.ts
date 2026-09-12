/**
 * Proving the provider is done writing, before its state is archived.
 *
 * The checkpoint drain gates **tool calls** — `beginWrite()` is called in
 * exactly one place — but the provider writes its own state (`/workspace/.codex`
 * and its session files) as itself, outside that gate. `provider-state` is an
 * archived area, so a checkpoint taken on the tool drain alone can capture a
 * half-written provider state and succeed, which is the worst of the three
 * outcomes because it looks like the good one.
 *
 * ## What counts as proof, and what does not
 *
 * Neither provider's existing shutdown path proves anything today, and both
 * were checked rather than assumed:
 *
 * - Claude Agent SDK 0.3.179 `waitForExit()` begins
 *   `if (this.process.exitCode !== null || this.process.killed || ...) return`.
 *   Node sets `killed` when a **signal is delivered**, not when the process
 *   dies, so that call can return while the child is still running and still
 *   writing. An exit has to be observed independently.
 * - Codex `disconnect()` (`codexAppServerClient.ts:941`) does `stdin.end()`,
 *   `SIGTERM`, and `SIGKILL` after two seconds. It never waits for the real
 *   exit, and a `SIGKILL` death is the opposite of a flushed one.
 *
 * So the rule is that absence of evidence is not evidence: a disconnect, a
 * turn boundary, or a process that was killed are **not** quiescence. Only the
 * full sequence below is, and anything short of it blocks the checkpoint as
 * `provider-state-unproven` — retryable, never recorded as a save.
 */

import type { ObservedProviderExit } from '@/launcher/managedProviderRun';
import type { GenerationKey } from '@/launcher/generationManifest';

/** Why a checkpoint may not treat the provider's state as settled. */
export type ProviderQuiescenceRefusal =
    /** New input, tool calls or a restart could still arrive. */
    | 'admission-open'
    /** Work admitted before the gate closed has not finished. */
    | 'work-in-flight'
    /** The provider was not driven to a normal end of input. */
    | 'eof-unverified'
    /** Nothing observed the child actually leaving. */
    | 'exit-unobserved'
    /** It left, but not cleanly. */
    | 'exit-nonzero'
    /** It was signalled. A killed provider did not flush. */
    | 'exit-signalled'
    /** Something is still holding the provider's state open. */
    | 'writers-remain'
    /** A provider started again; whatever was proven is no longer true. */
    | 'provider-restarted'
    /** A live generation this runtime cannot produce an observation for. */
    | 'generation-unaccounted';

/**
 * What one generation said as it ended, kept against that generation.
 *
 * Every field is an observation, including the missing ones: `nativeId: null`
 * is "it named no session", which is a different fact from "nobody asked". The
 * publisher has to be able to tell those apart, so nothing here is filtered on
 * its way out.
 */
export type GenerationTerminalObservation = {
    /** The launcher's own key for the entry, assigned when it created it. */
    handle: string;
    /**
     * This generation's identity, as its own entry holds it.
     *
     * Carried beside the answer so whatever later matches an observation
     * against a signed parent inventory does not have to look the generation up
     * again — a lookup that would have to go through
     * `ownedGenerationKeys()`, which is a different population and differs in
     * order exactly when something has gone wrong.
     */
    key: GenerationKey;
    stopped: boolean;
    /** A closed code, from `awaitGracefulStop`'s own vocabulary. */
    detail: string;
    /** The native session it named, spelled as it spelled it. */
    nativeId: string | null;
    /** It named two. Neither is usable. */
    identity: 'conflict' | null;
};

/**
 * Why provider state cannot be archived, and what was seen while deciding.
 *
 * `completeness` has exactly one value today, and deliberately no arm that says
 * the opposite. A runtime can see which session **this** generation ended; it
 * cannot see which earlier attempts this project needs in order to be
 * restorable. One live generation says nothing about that, and
 * `ownedGenerationKeys()` is a ledger of what must be answered for now, not a
 * recovery list. Until a signed parent inventory and a provider-typed coverage
 * contract exist, completeness is simply not established — and an arm nothing
 * can construct is an arm nobody can test, so there is not one.
 *
 * `generations` is carried regardless. It is what turns a dead end into a
 * diagnosis, and it is the half this runtime genuinely knows.
 */
export type ProviderStateObservation = {
    completeness: 'history-unestablished';
    generations: readonly GenerationTerminalObservation[];
};

export type ProviderQuiescence =
    | {
        quiesced: true;
        exitCode: 0;
        signal: null;
        /**
         * Optional in the type, always present from `proveProviderQuiescence`.
         *
         * Optional because a gate double that predates this field is still a
         * valid gate, and because absent and unestablished mean the same thing
         * to the only consumer: a proof that does not say provider state is
         * complete is a proof that provider state may not be archived. There is
         * no reading of "absent" that unlocks anything.
         */
        providerState?: ProviderStateObservation;
    }
    | {
        quiesced: false;
        reason: ProviderQuiescenceRefusal;
        /** Absent when the sequence stopped before anything was asked to end. */
        providerState?: ProviderStateObservation;
    };

/** What the runtime can actually observe about its provider. */
export type ProviderQuiescenceDeps = {
    /**
     * Closes admission and reports what was already in flight.
     *
     * Exclusive: new input, new tool calls and a provider restart are all
     * refused from the moment it returns until the gate is released.
     */
    closeAdmission: () => Promise<{ closed: boolean; inFlight: number }>;
    /** Waits for work admitted before the close. */
    awaitInFlight: () => Promise<{ drained: boolean }>;
    /**
     * Drives this provider to a normal end of input and reports whether it got
     * one — not whether a disconnect was requested.
     */
    endInput: () => Promise<{
        eof: boolean;
        /** What each generation said, kept per generation. */
        observed?: readonly GenerationTerminalObservation[];
    }>;
    /**
     * The child's real exit, observed independently of any SDK helper.
     *
     * `null` means it has not been seen to leave. A `signal` means it was
     * killed, which is never a flush.
     */
    observeExit: () => Promise<{ code: number | null; signal: string | null } | null>;
    /** Anything still holding the provider's state open. */
    writersRemaining: () => Promise<number>;
    /** How many times a provider has been started on this runtime. */
    providerStarts: () => number;
    /**
     * Generations nothing can produce an exit observation for — kept alive by
     * a failed stop, or open in the manifest from a previous runtime.
     *
     * Separate from `observeExit`, which answers for the generations being
     * proven. These are the ones nobody is watching at all, and their silence
     * is indistinguishable from quiet.
     *
     * A runtime-wide number. The launcher's own map is only part of it: a
     * reconciled generation never enters that map, so the manifest has to be
     * consulted too.
     */
    unobservableGenerations: () => number;
};

/**
 * Runs the sequence and returns proof or the first thing that failed.
 *
 * The order is the protocol and is not a preference: admission closes first so
 * nothing new can be admitted while the rest runs, and the restart count is
 * taken at the start and checked at the end so a provider that came back during
 * the sequence invalidates it rather than being missed.
 */
export async function proveProviderQuiescence(
    deps: ProviderQuiescenceDeps,
): Promise<ProviderQuiescence> {
    const startsBefore = deps.providerStarts();

    const admission = await deps.closeAdmission();
    if (!admission.closed) return { quiesced: false, reason: 'admission-open' };

    const drained = await deps.awaitInFlight();
    if (!drained.drained) return { quiesced: false, reason: 'work-in-flight' };

    const ended = await deps.endInput();
    /*
     * Snapshot taken here — after admission is closed and after the work
     * admitted before that close has drained, so nothing can join the set
     * between the observation and the archive. Held whatever the outcome: a
     * generation that refused to end is the single most informative thing this
     * sequence can learn, and it used to be the one that disappeared.
     */
    const providerState: ProviderStateObservation = {
        completeness: 'history-unestablished',
        generations: ended.observed ?? [],
    };
    if (!ended.eof) return { quiesced: false, reason: 'eof-unverified', providerState };

    const exit = await deps.observeExit();
    if (exit === null) return { quiesced: false, reason: 'exit-unobserved', providerState };
    // A signal first: a process that was killed has a code too, and reporting
    // `exit-nonzero` for a `SIGKILL` would hide that it was never flushed.
    if (exit.signal !== null) return { quiesced: false, reason: 'exit-signalled', providerState };
    if (exit.code !== 0) return { quiesced: false, reason: 'exit-nonzero', providerState };

    if (await deps.writersRemaining() > 0) return { quiesced: false, reason: 'writers-remain', providerState };

    /*
     * Before the restart check, because this is a different question: a
     * generation reconciled from a previous runtime never moves
     * `providerStarts`, so the check below cannot see it.
     */
    if (deps.unobservableGenerations() > 0) {
        return { quiesced: false, reason: 'generation-unaccounted', providerState };
    }

    // Last, because everything above takes time and a restart during any of it
    // makes the rest of the evidence describe a process that is gone.
    if (deps.providerStarts() !== startsBefore) {
        return { quiesced: false, reason: 'provider-restarted', providerState };
    }
    return { quiesced: true, exitCode: 0, signal: null, providerState };
}

/**
 * The gate a checkpoint holds for its whole length.
 *
 * `publishManagedCheckpoint` releases the tool drain in its `finally`, so the
 * moment it returns, writers resume. A stop that trusted that return would be
 * racing them. This gate is separate and is held from before the proof until
 * after the pointer is written — archive, upload and pointer included — and a
 * provider restart during any of it invalidates the proof rather than waiting
 * for someone to notice.
 */
export type ProviderQuiescenceGate = {
    /** The proof, or the reason there is none. Admission stays closed either way. */
    prove: () => Promise<ProviderQuiescence>;
    /** True while the proof taken by `prove` is still true. */
    stillProven: () => boolean;
    /** Reopens admission. Nothing may rely on the proof after this. */
    release: () => Promise<void>;
};

export function createProviderQuiescenceGate(deps: ProviderQuiescenceDeps & {
    reopenAdmission: () => Promise<void>;
}): ProviderQuiescenceGate {
    let proven: { at: number; starts: number } | null = null;
    return {
        async prove() {
            const outcome = await proveProviderQuiescence(deps);
            proven = outcome.quiesced ? { at: Date.now(), starts: deps.providerStarts() } : null;
            return outcome;
        },
        stillProven() {
            if (!proven) return false;
            // Re-asked rather than remembered: both answers can stop being
            // true between the proof and the pointer write, and a generation
            // reconciled in that window never moves the start count.
            return deps.providerStarts() === proven.starts
                && deps.unobservableGenerations() === 0;
        },
        async release() {
            proven = null;
            await deps.reopenAdmission();
        },
    };
}

/**
 * The real `endInput` for a runtime that has a control descriptor.
 *
 * Asks every live generation to end its input and waits for each to answer.
 * `eof` is true only when **all** of them stopped — provider state is archived
 * whole, so one generation that did not end is one that may still be writing.
 *
 * `awaitGracefulStop` already requires the three things that make an end of
 * input real: the child's own ack that its iterator ran out rather than being
 * aborted (which only the child can see), the observed exit, and an empty
 * cgroup. A generation with no channel answers `no-channel`, which is a
 * refusal — never a pass.
 */
/** A generation's own code, or `unknown`. Never its own text. */
function closedDetail(detail: string | undefined): string {
    return detail !== undefined && /^[a-z-]{1,40}$/.test(detail) ? detail : 'unknown';
}

export function endInputForLiveGenerations(input: {
    generations: () => Array<{
        /** The launcher's own key for this entry. */
        handle: string;
        /** This generation's identity, from its own entry. */
        key: GenerationKey;
        awaitGracefulStop: (budgetMs: number) => Promise<{
            stopped: boolean;
            detail?: string;
            /** The native session it named, as it spelled it. */
            nativeId?: string;
            identity?: 'conflict';
        }>;
    }>;
    /**
     * Why a generation would not end, as a closed code.
     *
     * `endInput` can only answer `eof: true|false`, so every reason a
     * generation gave was discarded here — and the gate then reported
     * `eof-unverified`, which says only that *something* refused. The whole
     * cause of a refusal has to be deducible from what is written down, and
     * this is the one place that knows it.
     */
    onRefused?: (detail: string) => void;
    /** Each generation's whole answer, for a caller that keeps them. */
    onObserved?: (observed: readonly GenerationTerminalObservation[]) => void;
    budgetMs: number;
}): () => Promise<{ eof: boolean; observed: readonly GenerationTerminalObservation[] }> {
    return async () => {
        const live = input.generations();
        // No generation is not an end of input; it is nothing to end. The
        // exit and writer checks that follow decide, rather than this.
        if (live.length === 0) return { eof: true, observed: [] };
        const answers = await Promise.all(
            live.map(async (generation) => ({
                handle: generation.handle,
                // Copied before the await: the entry may be replaced while this
                // is outstanding, and the answer belongs to the generation that
                // was asked.
                key: { ...generation.key },
                answer: await generation.awaitGracefulStop(input.budgetMs),
            })),
        );
        /*
         * One observation per generation, against **its own** handle — never
         * zipped against `ownedGenerationKeys()`, which is a different
         * population: a generation whose manifest record is closed is still
         * owned there while having no run left to speak to, so the two lists
         * differ in length and order exactly when something has gone wrong.
         *
         * Nothing is filtered. A generation that refused, one that named no
         * session and one that named two are three different facts, and the
         * consumer needs all three — flattening them into a list of ids is
         * what made the first version of this unsafe.
         */
        const observed: GenerationTerminalObservation[] = answers.map(({ handle, key, answer }) => ({
            handle,
            key,
            stopped: answer.stopped,
            // Sanitised here, not only on its way to a log: this observation
            // travels further than `onRefused` does, and a generation's own
            // string is not this runtime's to carry.
            detail: closedDetail(answer.detail),
            nativeId: answer.identity === 'conflict' ? null : answer.nativeId ?? null,
            identity: answer.identity ?? null,
        }));
        input.onObserved?.(observed);

        const refused = answers.find(({ answer }) => !answer.stopped);
        if (refused) {
            // A code, never a message: this crosses into a log the parent may
            // read, and the vocabulary is `awaitGracefulStop`'s own.
            input.onRefused?.(closedDetail(refused.answer.detail));
        }
        return { eof: !refused, observed };
    };
}

/**
 * The gate a running runtime actually hands to its checkpoint coordinator.
 *
 * Every observation below comes from something that looked:
 *
 * | dep                      | source                                        |
 * |--------------------------|-----------------------------------------------|
 * | `closeAdmission`         | the tool drain **and** the launcher's own      |
 * | `awaitInFlight`          | the tool drain's drain resolving               |
 * | `observeExit`            | the helper's watcher, via the launcher         |
 * | `writersRemaining`       | each live generation's `cgroup.events`         |
 * | `providerStarts`         | generations settled as `exec-attempted`        |
 * | `unobservableGenerations`| live generations with no run left to ask       |
 * | `endInput`               | the launcher's live generations, over the      |
 * |                          | supervisor→child control descriptor            |
 *
 * ## Why `endInput` is a required argument and not a default
 *
 * There is no channel from this runtime to the provider child's input. The
 * supervisor spawns the helper with `stdio[0..2] = 'ignore'`, so the child's
 * stdin is `/dev/null`; the only parent→child descriptors are the bootstrap
 * and report documents, both read once at startup. The only other lever is
 * `cgroup.kill`, and a killed provider is the opposite of a flushed one.
 *
 * So a normal end of input cannot be driven from here today. Rather than
 * default it to something — a `true` would be a fabricated proof, and a
 * permanent `false` would be a gate that can only ever refuse — it is a
 * required argument. A runtime can only build this gate once something can
 * genuinely end the provider's input and see it exit.
 */
/** One generation, as a value that can go in a set. */
function identityOf(key: { runId: string; attemptId: string; epoch: number }): string {
    return JSON.stringify([key.runId, key.attemptId, key.epoch]);
}

export function createManagedProviderQuiescenceGate(input: {
    /**
     * The tool drain — **observed, never acquired.**
     *
     * `publishManagedCheckpoint` drains for the length of the archive and
     * releases it in its `finally`. If this gate also called `drain()`, the
     * publisher's call would find one already in progress and every real
     * checkpoint would fail. One owner, and it is the publisher.
     *
     * So the gate reads instead: nothing in flight at the proof, and — via
     * the monotonic write count — nothing admitted between the proof and the
     * pointer write. A write that slips into that window makes the proof stop
     * holding rather than being excluded, which is the honest trade for not
     * having two owners of one gate.
     */
    drain: {
        inFlight: () => number;
        /**
         * Whether tool admission is actually closed right now.
         *
         * `beginWrite()` throws while a drain is in progress, so this is the
         * fact — not an intention. The gate reports admission closed only when
         * this says so.
         */
        isDraining: () => boolean;
        /** Monotonic. The evidence that nothing was written since the proof. */
        writes: () => number;
    };
    /** The generation launcher, for everything about providers. */
    launcher: {
        closeLaunchAdmission: () => { closed: boolean; inFlight: number };
        reopenLaunchAdmission: () => void;
        observedProviderExit: (handle: string) => ObservedProviderExit | null;
        liveHandles: () => string[];
        providerStarts: () => number;
        unobservableGenerations: () => number;
        writersRemaining: () => Promise<number>;
        ownedGenerationKeys: () => Array<{ runId: string; attemptId: string; epoch: number }>;
    };
    /**
     * The runtime-wide record of generations whose termination has not been
     * observed.
     *
     * Consulted separately from the launcher, because a generation reconciled
     * from a previous runtime is handled straight off the manifest and never
     * appears in the launcher's map — reading that map alone would report full
     * coverage while a generation from before the restart was still open.
     */
    manifest: {
        listOpen: () => {
            records: Array<{ runId: string; attemptId: string; epoch: number }>;
            unreadable: number;
        };
    };
    /**
     * Drives this runtime's provider to a normal end of input and reports
     * whether it got one — not whether a shutdown was requested. See above.
     */
    endInput: () => Promise<{
        eof: boolean;
        /** What each generation said, kept per generation. */
        observed?: readonly GenerationTerminalObservation[];
    }>;
}): ProviderQuiescenceGate {
    /**
     * The write count when the proof was taken.
     *
     * `null` while nothing is proven. Captured rather than compared later
     * against a remembered boolean: the question is whether *this* proof still
     * describes the volume, and only the count at that moment answers it.
     */
    let writesAtProof: number | null = null;
    const gate = createProviderQuiescenceGate({
        async closeAdmission() {
            /*
             * Two halves, and this gate closes only one of them.
             *
             * It closes launch admission: no new generation may be prepared.
             * Tool admission belongs to whoever holds the drain, and this gate
             * does not take it — see the note on `drain`.
             *
             * So `closed` is reported as closed only when **both** are, and
             * the tool half is read from the drain rather than assumed. A gate
             * that returned `closed: true` while `beginWrite()` was still
             * being accepted would be claiming an exclusion it does not have,
             * and every proof after it would describe a volume that could
             * still be written.
             *
             * The consequence is an ordering, stated in ORDERING.md: the
             * drain must already be held when the proof is taken.
             */
            const launches = input.launcher.closeLaunchAdmission();
            return {
                closed: launches.closed && input.drain.isDraining(),
                inFlight: launches.inFlight + input.drain.inFlight(),
            };
        },
        async awaitInFlight() {
            // Reported, not waited for. A budget for waiting belongs to
            // whoever drains; refusing a proof that was taken too early is
            // this gate's job, and a refusal is retryable.
            return {
                drained: input.drain.inFlight() === 0
                    && input.launcher.closeLaunchAdmission().inFlight === 0,
            };
        },
        endInput: input.endInput,
        async observeExit() {
            /*
             * Every live generation must have been seen to leave, not just
             * one: provider state is archived whole, and an unobserved
             * generation is a writer nobody watched.
             *
             * The first non-clean exit is what comes back, so a signalled one
             * is never hidden behind a clean one.
             */
            const handles = input.launcher.liveHandles();
            let last: ObservedProviderExit | null = null;
            for (const handle of handles) {
                const exit = input.launcher.observedProviderExit(handle);
                if (exit === null) return null;
                if (exit.signal !== null || exit.code !== 0) return exit;
                last = exit;
            }
            return last;
        },
        writersRemaining: input.launcher.writersRemaining,
        providerStarts: input.launcher.providerStarts,
        unobservableGenerations() {
            const open = input.manifest.listOpen();
            /*
             * An exact set difference on identity, never a subtraction of
             * sizes.
             *
             * The two sets are not nested. `recordTermination` closes a
             * generation's manifest record before its broker is closed, and a
             * close that fails keeps it owned here for good — so a generation
             * can be owned and not open. Comparing counts cancels one of those
             * against an unrelated open generation and reports coverage the
             * runtime does not have.
             */
            const owned = new Set(input.launcher.ownedGenerationKeys().map(identityOf));
            let unaccounted = 0;
            for (const record of open.records) {
                if (!owned.has(identityOf(record))) unaccounted += 1;
            }
            /*
             * An unreadable record counts too: it is the one case where the
             * runtime cannot even say what it does not know.
             */
            return unaccounted + open.unreadable + input.launcher.unobservableGenerations();
        },
        async reopenAdmission() {
            writesAtProof = null;
            input.launcher.reopenLaunchAdmission();
        },
    });
    return {
        async prove() {
            const outcome = await gate.prove();
            writesAtProof = outcome.quiesced ? input.drain.writes() : null;
            return outcome;
        },
        stillProven() {
            if (writesAtProof === null) return false;
            // A tool write admitted after the proof means the archive would
            // not describe what was proven.
            return input.drain.writes() === writesAtProof && gate.stillProven();
        },
        async release() {
            await gate.release();
        },
    };
}
