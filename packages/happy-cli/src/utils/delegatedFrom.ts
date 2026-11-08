/**
 * aplus-dev-studio specs/cross-machine-agent-delegation R9 — the daemon hands a delegated session the
 * linked machine and session it was started for; the runner records them as metadata `delegatedFrom`.
 * Under the scrubbed HAPPY_CREATED_BY prefix, so a session the child later starts does not inherit it.
 */
export const DELEGATED_FROM_MACHINE_ENV = 'HAPPY_CREATED_BY_DELEGATED_FROM_MACHINE_ID';
export const DELEGATED_FROM_SESSION_ENV = 'HAPPY_CREATED_BY_DELEGATED_FROM_SESSION_ID';

export function readDelegatedFromEnv(env: NodeJS.ProcessEnv): { machineId: string; sessionId: string } | undefined {
    const machineId = env[DELEGATED_FROM_MACHINE_ENV]?.trim();
    const sessionId = env[DELEGATED_FROM_SESSION_ENV]?.trim();
    // Both or neither: half a link cannot be checked against the parent's ledger.
    return machineId && sessionId ? { machineId, sessionId } : undefined;
}
