/**
 * The lesson-related environment a provider child is launched with.
 *
 * Two callers, and they must agree: a fresh spawn and a resume. They build
 * their environments completely differently — a resume rebuilds from the
 * tracked session and then runs the same caller sanitizer, which strips every
 * `HAPPY_LESSON_` and `CLAUDE_MEMORY_` key precisely so a caller cannot forge
 * them. That strip also removes the daemon's own two, so a resumed session
 * silently lost its state root and its owner marker; the first resume of any
 * session turned the host off and left an inherited marker deciding who
 * injects.
 *
 * Both now go through here, which is what keeps them in step: the state root
 * and the ownership decision are made in one place, from arguments the daemon
 * owns, after the sanitizer has run.
 */
import { LESSON_DAEMON_HOME_ENV } from './lessonSessionHost';
import {
    applyLessonOwner,
    decideLessonOwner,
    type LessonOwnerDecision,
} from './lessonOwnerMarker';
import { tokensShareIdentity } from '@/daemon/resumeCredentials';

export type LessonLaunchInput = {
    /** The environment after caller sanitization. Never mutated. */
    environment: Record<string, string>;
    /**
     * The credential the child will actually authenticate with — the staged
     * user's on a collaborator session, the daemon's otherwise.
     */
    callerToken: string | null | undefined;
    /** The credential the readiness proof is taken with. */
    daemonToken: string;
    /** The daemon's own home, which owns settings, the ledger and outcomes. */
    daemonHomeDir: string;
    /** Trusted project binding, or null when there is none to act on. */
    projectId: string | null | undefined;
    /** Cheap preconditions the caller already resolved. */
    eligible: boolean;
    /** Consumed server caller grant; actual session authority is checked after registration. */
    hasSessionAuthority?: boolean;
    /** Opens the project through a signed grant; `false` means no host. */
    hostIsReady: () => Promise<boolean>;
    /** The installed package probe, for tests. Production passes nothing. */
    load?: Parameters<typeof decideLessonOwner>[0]['load'];
};

/**
 * Whether the child will ask the studio as the account the readiness proof was
 * taken with.
 *
 * Token subjects, so a re-issued token for the same user still counts, and a
 * relocated home for that same user is not a different identity — the home
 * moves, the account does not.
 */
export function lessonCallerSharesIdentity(
    callerToken: string | null | undefined,
    daemonToken: string,
): boolean {
    return !callerToken || tokensShareIdentity(callerToken, daemonToken);
}

export async function applyLessonLaunchEnvironment(
    input: LessonLaunchInput,
): Promise<{ environment: Record<string, string>; decision: LessonOwnerDecision }> {
    const decision = await decideLessonOwner({
        // Project control and caller support are separate: an unsupported
        // caller must not escape the host policy boundary through native hooks.
        eligible: input.eligible && Boolean(input.projectId),
        callerSupported: lessonCallerSharesIdentity(input.callerToken, input.daemonToken),
        // Never open as the daemon on behalf of a session caller. The provider
        // obtains its own signed path and identity after its session is registered.
        hostIsReady: async () => !input.hasSessionAuthority && Boolean(input.projectId) && input.hostIsReady(),
        load: input.load,
    });
    return {
        /*
         * The state root is re-injected here because the sanitizer just
         * removed it, and the marker is always written — `native` included —
         * so an inherited `host` cannot survive into a launch that decided
         * otherwise.
         */
        environment: applyLessonOwner(
            { ...input.environment, [LESSON_DAEMON_HOME_ENV]: input.daemonHomeDir },
            decision,
        ),
        decision,
    };
}
