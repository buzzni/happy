/**
 * New conversations on a protected (work-machine enrolled) machine.
 *
 * The Happy server refuses the account token for daemon writes on such a
 * machine, and a child there runs only on a session credential for an
 * existing conversation. So the daemon creates each new conversation itself
 * with its device daemon credential (`wmx_`), which the server attaches to the
 * machine's work-machine execution, records it like any daemon-created
 * session, and hands the child the usual fresh attach. The child then obtains
 * that conversation's session credential exactly as a resumed one does.
 *
 * An unprotected machine is left unchanged: its child creates the
 * conversation with the account token.
 */

import { randomUUID } from 'node:crypto';
import { ApiClient } from '@/api/api';
import type { Metadata, Session } from '@/api/types';
import type { Credentials } from '@/persistence';
import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';
import { buildReconnectSessionEnvironment, RECONNECT_FRESH_LAUNCH_ENV } from './reconnectSessionEnv';

export type WorkMachineNewSession =
    | { kind: 'unprotected' }
    | { kind: 'created'; session: Session; environment: Record<string, string> }
    | { kind: 'refused'; errorMessage: string };

export async function prepareWorkMachineNewSession(input: {
    protectedMachine: boolean;
    options: Pick<SpawnSessionOptions, 'sessionId' | 'resumeClaudeSessionId' | 'resumeCodexThreadId' | 'parentSessionId'>;
    /** The daemon's current credentials; on a protected machine the token is the device daemon credential. */
    credentials: Credentials;
    metadata: Metadata;
    /** Durably records the created session before any child can run on it. */
    persist: (session: Session) => Promise<boolean>;
}): Promise<WorkMachineNewSession> {
    if (!input.protectedMachine) return { kind: 'unprotected' };
    const { sessionId, resumeClaudeSessionId, resumeCodexThreadId, parentSessionId } = input.options;
    if (sessionId || resumeClaudeSessionId || resumeCodexThreadId || parentSessionId) {
        return { kind: 'refused', errorMessage: 'Forks and continuations are not supported on a work machine yet' };
    }
    if (!input.credentials.token.startsWith('wmx_')) {
        return { kind: 'refused', errorMessage: 'Work machine conversation creation requires the device credential' };
    }
    const api = await ApiClient.create(input.credentials);
    // The server refuses while the generation drains, is frozen or moved to another device.
    const session = await api.getOrCreateSession({ tag: randomUUID(), metadata: input.metadata, state: null }).catch(() => null);
    if (!session) return { kind: 'refused', errorMessage: 'Work machine conversation could not be created; retry when the server is reachable' };
    if (!await input.persist(session)) return { kind: 'refused', errorMessage: 'Work machine conversation could not be recorded locally' };
    return {
        kind: 'created',
        session,
        environment: {
            ...buildReconnectSessionEnvironment({ sessionId: session.id, encryption: session, serverSnapshot: session, baselineSeq: 0 }),
            [RECONNECT_FRESH_LAUNCH_ENV]: '1',
        },
    };
}

/**
 * Whether a protected child starts the provider fresh for a conversation the
 * daemon just created. A conversation with a recorded provider session always
 * resumes it, so a missing transcript is never replaced by an empty one.
 */
export function startsNewWorkMachineConversation(freshLaunch: boolean, providerSessionId: string | undefined): boolean {
    return freshLaunch && !providerSessionId;
}
