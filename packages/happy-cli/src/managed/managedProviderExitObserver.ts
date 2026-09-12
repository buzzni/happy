/**
 * Watching the SDK's own child leave, independently of anything that asked it
 * to.
 *
 * The quiescence gate already has the *generation's* exit, seen by the trusted
 * helper's watcher. This is the layer below: the process the Claude Agent SDK
 * spawns inside the managed child. A clean generation exit does not by itself
 * say the SDK's own process finished writing — it says the helper saw the
 * generation's cgroup empty.
 *
 * ## Why a signal is never a flush, and why "forced" is tracked separately
 *
 * `waitForExit()` in the installed SDK (0.3.179) returns early when
 * `process.killed` is set, and Node sets that when a signal is *delivered*,
 * not when the process dies. So an exit has to be observed here, from the
 * child object, rather than taken from the SDK's own helper.
 *
 * `signal !== null` catches a kill the kernel reported. It does not catch a
 * process that **handled** the signal and exited 0 — the kernel then reports
 * no signal at all, and the exit reads exactly like a graceful end.
 *
 * Two independent things catch that, because one of them can be forgotten:
 *
 *  - `child.killed`, read at the exit. Node sets it when a signal was
 *    delivered, whatever the process did next, so a kill that no code path
 *    announced is still seen.
 *  - `markForced()`, called at every kill and cancellation boundary **before**
 *    the signal — `response.close()`, the abort path — because a cancellation
 *    can be honoured without any signal being sent at all.
 *
 * Neither alone is enough. Absence of evidence is not evidence.
 */
export type ObservedSdkExit = {
    code: number | null;
    signal: string | null;
    /** Something asked this process to die, whatever the exit then said. */
    forced: boolean;
};

export type WatchedChild = {
    once: (event: 'exit', handler: (code: number | null, signal: string | null) => void) => unknown;
    /**
     * Node sets this when a signal was **delivered**, whatever the process
     * then did with it. Read at the exit, so a kill nobody announced is still
     * seen.
     */
    killed?: boolean;
};

export type ProviderExitObserver = {
    /** Starts watching one spawned process. */
    watch: (child: WatchedChild) => void;
    /** Records that a kill was requested, before or after the exit. */
    markForced: () => void;
    /** What was seen, or `null` for "not seen". Never waits. */
    observed: () => ObservedSdkExit | null;
    /** The only shape that counts as the SDK having finished on its own. */
    exitedCleanly: () => boolean;
};

export function createProviderExitObserver(
    /**
     * Called the first time a real process is watched.
     *
     * This — not a wrapper loop iteration — is when a provider generation
     * begins. A loop turn that never launches a query has no generation, and
     * treating it as one discards the previous generation's evidence and
     * refuses a checkpoint that should have been allowed.
     */
    onGenerationStarted?: () => void,
): ProviderExitObserver {
    let observed: ObservedSdkExit | null = null;
    let forced = false;
    let started = false;
    return {
        watch(child) {
            if (!started) {
                started = true;
                onGenerationStarted?.();
            }
            child.once('exit', (code, signal) => {
                // First observation only. The process ends once; a later write
                // would be something other than what the kernel reported.
                if (observed !== null) return;
                // `child.killed` is read here rather than trusted from a
                // caller: it is true whenever a signal was delivered, which
                // catches a kill that no code path announced.
                observed = { code, signal, forced: forced || child.killed === true };
            });
        },
        markForced() {
            forced = true;
            // Also applied to an exit already seen: a kill requested during
            // shutdown can land after the exit event, and the exit was still
            // not one this process chose.
            if (observed !== null) observed = { ...observed, forced: true };
        },
        observed: () => observed,
        exitedCleanly: () => observed !== null
            && observed.code === 0
            && observed.signal === null
            && !observed.forced,
    };
}

/**
 * How long a managed run waits for its own provider to be seen leaving before
 * it reports the turn's verdict.
 */
export const MANAGED_REPORT_EXIT_BUDGET_MS = 10_000;

/**
 * Waits, bounded, for an exit to be observed.
 *
 * The wrapper's message loop ends before the SDK child does — `claudeRemote`
 * returns as soon as the iterator is exhausted, and the process it spawned
 * exits a moment afterwards. Reading the observer at that instant reports a
 * provider that is exiting perfectly well as unclean, and the runtime then
 * refuses the checkpoint for a reason that was only ever a race.
 *
 * Returns whatever is true when it gives up. A timeout is **not** turned into
 * an exit: the observer keeps saying "not seen", and the verdict is built from
 * that.
 */
export async function waitForObservedExit(
    observer: Pick<ProviderExitObserver, 'observed'>,
    budgetMs: number,
    deps: { wait?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<void> {
    const now = deps.now ?? (() => Date.now());
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref?.();
    }));
    const deadline = now() + budgetMs;
    while (observer.observed() === null && now() < deadline) {
        await wait(25);
    }
}
