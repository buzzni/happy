import type { DelegationLaneConfig, DelegationLink } from './types';

/**
 * aplus-dev-studio specs/cross-machine-agent-delegation (happy spec R7) — the machine-scope methods
 * another machine may call with a delegation link key a person installed from Desktop.
 *
 * Enough to start an agent here under this machine's own policy, read that agent's session key, stop
 * it, and ask which Claude credentials this machine would use. Nothing that reads or writes a file,
 * runs a command, opens a terminal or touches a session this link did not create.
 *
 * An allowlist, not a denylist: a method added later stays closed to the lane until it is reviewed
 * and listed here.
 */
export const DELEGATION_LANE_METHODS: ReadonlySet<string> = new Set([
    'agent-delegation:spawn',
    'agent-delegation:session-key',
    // Only for a session this link created (`admit`, wired by the daemon).
    'stop-session',
    'ai-credential:status',
    'ai-credential:capabilities',
]);

/**
 * The delegation lane of a machine's RPC scope. `links` is read on every request a lane key could
 * open, so a revoked link stops opening requests at once.
 */
export function machineDelegationLane(input: {
    links: () => readonly DelegationLink[];
    admit?: DelegationLaneConfig['admit'];
}): DelegationLaneConfig {
    return {
        links: input.links,
        allows: (method) => DELEGATION_LANE_METHODS.has(method),
        ...(input.admit ? { admit: input.admit } : {}),
    };
}
