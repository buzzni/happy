import { readCheckpointSpawnContext } from '@/checkpoint/checkpointSpawnContext';
import { isAutomationExecutionSessionId } from '@slopus/happy-wire';

/**
 * The durable memory boundary for a provider session.
 *
 * A personal Chat still has a working directory, but that directory is not a
 * project identity. Only the daemon-authenticated checkpoint binding can open
 * project memory. The account-level personal memory is owned by Studio and is
 * deliberately outside this provider-side scope.
 */
export type SessionMemoryScope =
    | { kind: 'project'; scopeId: string; projectPath: string }
    | { kind: 'session'; scopeId: string };

export function resolveSessionMemoryScope(input: {
    env: Record<string, string | undefined>;
    projectPath: string;
    sessionId: string;
}): SessionMemoryScope {
    if (isAutomationExecutionSessionId(input.sessionId)) return { kind: 'session', scopeId: input.sessionId };
    const projectId = readCheckpointSpawnContext(input.env)?.projectId;
    if (projectId && input.projectPath.trim()) {
        return { kind: 'project', scopeId: projectId, projectPath: input.projectPath };
    }
    return { kind: 'session', scopeId: input.sessionId };
}
