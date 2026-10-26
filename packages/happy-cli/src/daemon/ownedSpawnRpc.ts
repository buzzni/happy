/** The existing encrypted machine RPC binding is the only public entry to this coordinator. */
import type { createOwnedSpawn } from './ownedSpawn';
export interface OwnedSpawnRpc {
    capabilities(raw: unknown): Promise<{ ownedSpawnPrepareV1: boolean }>;
    prepare: ReturnType<typeof createOwnedSpawn>['prepare'];
    commit: ReturnType<typeof createOwnedSpawn>['commit'];
    start: ReturnType<typeof createOwnedSpawn>['start'];
    status: ReturnType<typeof createOwnedSpawn>['status'];
    callerBinding(raw: unknown): Promise<unknown>;
}
export function registerOwnedSpawnRpc(register: (method: string, handler: (raw: unknown) => Promise<unknown>) => void, owned?: OwnedSpawnRpc) {
    register('owned-spawn-capabilities', raw => owned?.capabilities(raw) ?? Promise.resolve({ ownedSpawnPrepareV1: false }));
    if (!owned) return;
    for (const [name, handler] of [ ['prepare-owned-spawn', owned.prepare], ['commit-owned-spawn', owned.commit],
        ['start-created-session', owned.start], ['start-owned-spawn', owned.start], ['create-session-status', owned.status],
        ['owned-spawn-status', owned.status], ['agent-caller-binding', owned.callerBinding] ] as const) register(name, handler);
}
