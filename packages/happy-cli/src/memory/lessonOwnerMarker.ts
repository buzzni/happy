/**
 * A supported Studio-bound launch keeps lesson injection behind the host's
 * settings and signed grant checks. Readiness is availability, not authority:
 * falling back to a native hook after refusal bypasses OFF and Studio ACLs.
 * Standalone / unknown-capability installs retain native ownership; they do
 * not claim the host policy guarantee. No user hook configuration is changed.
 */
import { loadCmlLessonHost, type CmlLessonHostLoad } from './cmlLessonHost';

export const LESSON_OWNER_ENV = 'CLAUDE_MEMORY_LESSON_OWNER';
export const LESSON_OWNER_HOST = 'host';
export const LESSON_OWNER_NATIVE = 'native';
/** Internal launch control; the caller sanitizer strips HAPPY_LESSON_* keys. */
export const LESSON_HOST_DISABLED_ENV = 'HAPPY_LESSON_HOST_DISABLED';
export const REQUIRED_LESSON_OWNER_CAPABILITY = Object.freeze({
    version: 1,
    nativeLessonOwnerMarker: true,
});

export type LessonOwner = 'host' | 'native' | 'disabled';
export type LessonOwnerDecision = {
    owner: LessonOwner;
    reason: 'claimed' | 'capability-missing' | 'store-unavailable'
        | 'host-unavailable' | 'host-not-ready' | 'unsupported-caller';
};

export function supportsNativeOwnerMarker(load: CmlLessonHostLoad): boolean {
    if (!load.ok) return false;
    const stated = (load.modules as unknown as {
        LESSON_HOST_CAPABILITIES?: { version?: unknown; nativeLessonOwnerMarker?: unknown };
    }).LESSON_HOST_CAPABILITIES;
    if (!stated || typeof stated !== 'object') return false;
    return stated.version === REQUIRED_LESSON_OWNER_CAPABILITY.version
        && stated.nativeLessonOwnerMarker === REQUIRED_LESSON_OWNER_CAPABILITY.nativeLessonOwnerMarker;
}

export const LESSON_OWNER_DECISION_BUDGET_MS = 1_000;

export async function decideLessonOwner(input: {
    eligible: boolean;
    callerSupported?: boolean;
    hostIsReady: () => Promise<boolean>;
    env?: NodeJS.ProcessEnv;
    load?: typeof loadCmlLessonHost;
    budgetMs?: number;
}): Promise<LessonOwnerDecision> {
    if (!input.eligible) return { owner: 'native', reason: 'host-unavailable' };
    let capabilityVerified = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unavailable = (): LessonOwnerDecision => ({
        owner: capabilityVerified ? 'host' : 'native', reason: 'host-not-ready',
    });
    const deadline = new Promise<LessonOwnerDecision>((resolve) => {
        timer = setTimeout(() => resolve(unavailable()), input.budgetMs ?? LESSON_OWNER_DECISION_BUDGET_MS);
        timer.unref?.();
    });
    const work = (async (): Promise<LessonOwnerDecision> => {
        let load: CmlLessonHostLoad;
        try {
            load = await (input.load ?? loadCmlLessonHost)(input.env ?? process.env);
        } catch {
            return { owner: 'native', reason: 'store-unavailable' };
        }
        // A late probe cannot authorize a launch or start an unnecessary grant request.
        if (finished) return unavailable();
        if (!load.ok) return { owner: 'native', reason: 'store-unavailable' };
        if (!supportsNativeOwnerMarker(load)) return { owner: 'native', reason: 'capability-missing' };
        capabilityVerified = true;
        if (input.callerSupported === false) return { owner: 'disabled', reason: 'unsupported-caller' };
        const ready = await input.hostIsReady().catch(() => false);
        return { owner: 'host', reason: ready ? 'claimed' : 'host-not-ready' };
    })();
    try {
        return await Promise.race([work, deadline]);
    } finally {
        finished = true;
        if (timer) clearTimeout(timer);
    }
}

/**
 * CML v1 only recognizes "host" as suppression; sending it "disabled" would
 * accidentally enable native injection. Suppress CML with its existing marker
 * and independently stop Happy bootstrap for an unsupported caller. Always
 * overwrite the internal flag so an inherited disabled value cannot survive
 * into the next supported launch, including resume.
 */
export function applyLessonOwner(
    environment: Record<string, string>,
    decision: LessonOwnerDecision,
): Record<string, string> {
    return {
        ...environment,
        [LESSON_OWNER_ENV]: decision.owner === 'native' ? LESSON_OWNER_NATIVE : LESSON_OWNER_HOST,
        [LESSON_HOST_DISABLED_ENV]: decision.owner === 'disabled' ? decision.reason : '',
    };
}

export function readLessonOwner(env: NodeJS.ProcessEnv = process.env): LessonOwner {
    if (env[LESSON_HOST_DISABLED_ENV]) return 'disabled';
    return env[LESSON_OWNER_ENV] === LESSON_OWNER_HOST ? 'host' : 'native';
}
