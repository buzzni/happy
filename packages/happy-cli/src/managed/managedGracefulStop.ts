/**
 * Ending a managed run's input without killing it.
 *
 * A checkpoint that archives provider state needs the provider to have
 * finished writing, and the only thing that proves that is a normal end of
 * input followed by a clean exit. Every shortcut available today is a kill:
 *
 * - `abortController.abort()` cancels the turn in progress. A cancelled turn
 *   is not a finished one.
 * - `killSession` / SIGTERM / `cgroup.kill` end the process. A killed provider
 *   did not flush.
 * - Claude's `response.close()` schedules a kill, and Codex's
 *   `disconnectInternal` does `stdin.end()` and then SIGTERM immediately with
 *   SIGKILL two seconds later, never awaiting the real exit.
 *
 * The one path that is a genuine exhaustion runs through the message loop:
 * `nextMessage()` returning `null` calls `messages.end()`, which ends the
 * SDK's streaming input, which ends the child's stdin, which gives stdout EOF
 * and a real `waitForExit`. This object decides when that may happen.
 *
 * ## The exhaustion is not kept here
 *
 * A stop is asked of the *session* and stays asked until something ends. An
 * exhaustion belongs to one **provider generation** — the SDK process whose
 * input ended — so it is recorded beside that generation's exit observer and
 * not on this object. Keeping it here made it a shared latch that a later loop
 * turn, or a turn that never launched anything, could read or write.
 *
 * ## Why the queue cannot simply be closed
 *
 * `MessageQueue2.close()` wakes a waiter with `false`, which is exactly the
 * `null` the loop needs — but only when nothing is queued.
 * `waitForMessagesAndGetAsString` returns any queued batch *before* it looks
 * at `closed`, so closing while messages are pending delivers them into a run
 * that is trying to end, and a message already promoted to `pending` for the
 * next turn is not in the queue at all. Both have to be empty first, which is
 * why admission closes before this is asked.
 */
export type ManagedGracefulStop = {
    /**
     * Ask the run to end after the work it has already accepted.
     *
     * Idempotent, and never cancels anything. If the run is idle it is woken
     * so the waiting `nextMessage()` can return; if it is mid-turn nothing
     * happens now and the turn boundary picks it up.
     */
    request: () => void;
    /** Whether a stop has been asked for. */
    requested: () => boolean;
    /**
     * Whether input may end right now: asked for, nothing queued, nothing
     * held back for the next turn.
     */
    mayEndInput: () => boolean;
};

export function createManagedGracefulStop(deps: {
    /** How many messages are waiting to be delivered. */
    queueSize: () => number;
    /** A message already taken off the queue for the next turn. */
    hasPending: () => boolean;
    /**
     * Wakes a `nextMessage()` that is currently waiting for input.
     *
     * Called only when nothing is queued and nothing is pending, because that
     * is the only state in which the wake produces `null` rather than
     * delivering work into a run that is ending.
     */
    wake: () => void;
}): ManagedGracefulStop {
    let requested = false;
    const mayEndInput = () => requested && deps.queueSize() === 0 && !deps.hasPending();
    return {
        request() {
            // Idempotent: a second ask must not wake a run twice, and must
            // never look like a fresh reason to end something already ending.
            if (requested) return;
            requested = true;
            // Mid-turn, or with work accepted: the turn boundary asks again.
            // Waking here would close the queue over messages that were
            // admitted before the stop.
            if (mayEndInput()) deps.wake();
        },
        requested: () => requested,
        mayEndInput,
    };
}

/**
 * The child's one graceful stop, reachable from where the request arrives.
 *
 * The control channel is read at startup; the object that can act on a stop is
 * built later, inside the message loop, because it needs that loop's `pending`.
 * So the two cannot simply be handed to each other.
 *
 * A request that arrives before the loop exists is **remembered**, not
 * dropped — a checkpoint that asked during startup would otherwise wait for an
 * end of input that nobody was left to deliver.
 */
let current: ManagedGracefulStop | null = null;
let requestedBeforeRegistered = false;

/** Called by the message loop once it can act on a stop. */
export function registerManagedGracefulStop(stop: ManagedGracefulStop | null): void {
    current = stop;
    if (stop && requestedBeforeRegistered) {
        requestedBeforeRegistered = false;
        stop.request();
    }
}

/** Called by the control channel when the supervisor asks for a stop. */
export function requestManagedGracefulStop(): void {
    if (current) {
        current.request();
        return;
    }
    requestedBeforeRegistered = true;
}

/** Test seam: forgets both the registration and any remembered request. */
export function resetManagedGracefulStopForTests(): void {
    current = null;
    requestedBeforeRegistered = false;
}

/**
 * Ending a managed turn's input and giving the provider a chance to leave on
 * its own before anything kills it.
 *
 * Two turn shapes return without ever going through `nextMessage()`, so
 * neither reaches the exhaustion path above:
 *
 *  - `completeTurn` (checkpoint protection) calls `messages.end()` — a real
 *    end of input — and then immediately `response.close()`, which schedules a
 *    kill. The end was genuine; the kill right behind it is what makes the
 *    exit unusable as proof.
 *  - `exitAfterFirstTurn` (automation) returns without ending the iterator at
 *    all, so the provider is torn down with its input still open.
 *
 * This gives both the same shape: end the input, **wait** for the provider to
 * exit on its own, and fall back to the caller's forced close only if it does
 * not. The fallback is reported, never hidden — a forced close is not a flush,
 * and the quiescence gate must see the difference.
 */
export async function endManagedTurnInput(deps: {
    /** Ends the SDK's streaming input. The real end of input. */
    endInput: () => void;
    /**
     * Whether the provider's own process has been seen to exit cleanly.
     * Polled, never awaited on a promise that may never settle.
     */
    exitedCleanly: () => boolean;
    /** Last resort. Kills the provider; the caller records that it was forced. */
    forceClose: () => Promise<void>;
    /** How long the provider gets to leave on its own. */
    budgetMs: number;
    /** Sleeps between polls. Injected so tests do not wait. */
    wait?: (ms: number) => Promise<void>;
    now?: () => number;
}): Promise<{ exhausted: boolean; forced: boolean }> {
    const now = deps.now ?? (() => Date.now());
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref?.();
    }));

    // The end of input itself. Everything after this is about whether the
    // provider took the opportunity.
    deps.endInput();

    const deadline = now() + deps.budgetMs;
    while (now() < deadline) {
        if (deps.exitedCleanly()) return { exhausted: true, forced: false };
        await wait(25);
    }
    // One last look before forcing: the exit can land inside the final gap.
    if (deps.exitedCleanly()) return { exhausted: true, forced: false };

    /*
     * It did not leave. The input still genuinely ended — that is why
     * `exhausted` stays true — but the close below is a kill, and a killed
     * provider did not flush. The caller marks it forced, and the gate refuses
     * on the exit rather than on the exhaustion.
     */
    await deps.forceClose();
    return { exhausted: true, forced: true };
}
