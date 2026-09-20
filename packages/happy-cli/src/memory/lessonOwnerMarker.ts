/**
 * Which component injects lessons into a session: CML's native hook, or this
 * host. Exactly one, decided once per provider launch.
 *
 * CML's `UserPromptSubmit` hook injects lessons on its own, and its
 * `SessionStart` hook writes a lesson index. Both stand down when the launch
 * environment carries `CLAUDE_MEMORY_LESSON_OWNER=host`. Without that marker
 * they keep working exactly as they always have — which is what must happen
 * whenever this host is not going to inject, because the alternative is a
 * session with no lessons at all.
 *
 * Two rules make this safe.
 *
 * **Decided at launch, fixed for the process.** The host boots lazily, so
 * "ready" is a moving target within a session; a marker that followed it would
 * mean the native hook stood down halfway through, or that both injected
 * across the switch. The decision is made once, before the provider starts,
 * and the next launch decides again.
 *
 * **Claimed only against a host that is actually ready.** Two things have to
 * hold, and checking either alone loses memory:
 *
 *  - the installed CML must honour the marker, or an older build injects
 *    anyway and the session gets everything twice;
 *  - a working host must already exist for this project — proved by opening
 *    it, not by the preconditions looking right. A marker set on hope silences
 *    the native hook, and if the host then fails to authenticate or is still
 *    booting, the session has no lessons at all. That is worse than double
 *    injection and far quieter.
 *
 * The proof is the daemon's own supervisor: it opens the project through the
 * same signed grant a turn would, and only a runtime that came back is a host.
 *
 * Nothing here touches `~/.claude/settings.json` or any other user
 * configuration: the marker lives in one child process's environment and
 * disappears with it. Managed runs are unaffected — they load no settings
 * sources, so they have no native hook to stand down and no host to claim.
 */
import { loadCmlLessonHost, type CmlLessonHostLoad } from './cmlLessonHost';

export const LESSON_OWNER_ENV = 'CLAUDE_MEMORY_LESSON_OWNER';
/** The only value that means "this host injects"; anything else is native. */
export const LESSON_OWNER_HOST = 'host';

/**
 * The capability the installed package must state.
 *
 * Checked exactly — `version` and the flag both. A build that predates the
 * guard exports nothing here, and one that changes the contract will say so
 * with a different version rather than silently meaning something else.
 */
export const REQUIRED_LESSON_OWNER_CAPABILITY = Object.freeze({
    version: 1,
    nativeLessonOwnerMarker: true,
});

export type LessonOwner = 'host' | 'native';

export type LessonOwnerDecision = {
    owner: LessonOwner;
    /**
     * Why, for the log.
     *
     * `capability-missing` means CML is installed but too old to stand down.
     * `host-not-ready` means the store is there and the marker would work, but
     * no host could actually be opened for this project — so the native hook
     * keeps the session's memory rather than both sides going quiet.
     */
    reason:
        | 'claimed'
        | 'capability-missing'
        | 'store-unavailable'
        | 'host-unavailable'
        | 'host-not-ready';
};

/** Reads and checks the installed package's stated capability. */
export function supportsNativeOwnerMarker(load: CmlLessonHostLoad): boolean {
    if (!load.ok) return false;
    const stated = (load.modules as unknown as {
        LESSON_HOST_CAPABILITIES?: { version?: unknown; nativeLessonOwnerMarker?: unknown };
    }).LESSON_HOST_CAPABILITIES;
    if (!stated || typeof stated !== 'object') return false;
    return stated.version === REQUIRED_LESSON_OWNER_CAPABILITY.version
        && stated.nativeLessonOwnerMarker === REQUIRED_LESSON_OWNER_CAPABILITY.nativeLessonOwnerMarker;
}

/**
 * Decides ownership for one provider launch.
 *
 * `eligible` is the cheap precondition — not a managed run, an authoritative
 * project, a configured studio. `hostIsReady` is the expensive one, and it is
 * a question the daemon answers by actually opening the project: it returns
 * true only when a real host exists for it right now.
 *
 * Order matters. `hostIsReady` is only asked once the store is present and
 * states the capability, so a deployment that cannot use the marker never pays
 * for the open.
 */
/**
 * How long the whole decision may take.
 *
 * It sits in front of starting an ordinary session, and both steps touch a
 * store the daemon does not control — loading the package reads from disk and
 * proving readiness reaches the studio. A hang there must not hold a session
 * open, so the budget covers the decision end to end and a timeout is
 * `native`: CML's hook keeps working and nothing waits.
 */
export const LESSON_OWNER_DECISION_BUDGET_MS = 1_000;

export async function decideLessonOwner(input: {
    eligible: boolean;
    hostIsReady: () => Promise<boolean>;
    env?: NodeJS.ProcessEnv;
    load?: typeof loadCmlLessonHost;
    budgetMs?: number;
}): Promise<LessonOwnerDecision> {
    if (!input.eligible) return { owner: 'native', reason: 'host-unavailable' };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<LessonOwnerDecision>((resolve) => {
        timer = setTimeout(
            () => resolve({ owner: 'native', reason: 'host-not-ready' }),
            input.budgetMs ?? LESSON_OWNER_DECISION_BUDGET_MS,
        );
        timer.unref?.();
    });
    const work = (async (): Promise<LessonOwnerDecision> => {
        const load = await (input.load ?? loadCmlLessonHost)(input.env ?? process.env);
        if (!load.ok) {
            // No store at all: nothing to own, and nothing native either.
            return { owner: 'native', reason: 'store-unavailable' };
        }
        if (!supportsNativeOwnerMarker(load)) {
            return { owner: 'native', reason: 'capability-missing' };
        }
        const ready = await input.hostIsReady().catch(() => false);
        // The decisive check: a marker set before a host exists silences the
        // native hook for a session that then has nothing to inject.
        if (!ready) return { owner: 'native', reason: 'host-not-ready' };
        return { owner: 'host', reason: 'claimed' };
    })();

    try {
        /*
         * Whichever answers first wins, and it wins permanently. A readiness
         * check that completes after the deadline does not reopen the
         * decision — the child has already been launched with the marker this
         * returned, and changing it afterwards would mean the two sides
         * disagreed about who injects.
         */
        return await Promise.race([work, deadline]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Written when the decision is `native`, so inheritance cannot override it. */
export const LESSON_OWNER_NATIVE = 'native';

/**
 * Applies a decision to a child's environment.
 *
 * A native decision writes `native` rather than deleting the key. Deleting is
 * not enough: the spawn merges `{ ...process.env, ...extraEnv }`, so a value
 * on the daemon's own environment would come back through inheritance and
 * silence CML's hook for a launch this decided must keep it. Only the exact
 * string `host` means this host injects, so any other value is safe — and
 * writing one states the decision instead of hoping for its absence.
 */
export function applyLessonOwner(
    environment: Record<string, string>,
    decision: LessonOwnerDecision,
): Record<string, string> {
    return {
        ...environment,
        [LESSON_OWNER_ENV]: decision.owner === 'host' ? LESSON_OWNER_HOST : LESSON_OWNER_NATIVE,
    };
}

/**
 * What this process was launched as.
 *
 * Read once by the session host so its own behaviour matches the decision the
 * daemon already communicated to CML. A host that injected while the marker
 * said `native` would be the double injection from the other direction.
 */
export function readLessonOwner(env: NodeJS.ProcessEnv = process.env): LessonOwner {
    return env[LESSON_OWNER_ENV] === LESSON_OWNER_HOST ? 'host' : 'native';
}
