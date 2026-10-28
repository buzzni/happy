/**
 * The session RPCs that let the person see and take back this conversation's grants
 * (aplus-dev-studio specs/agent-tool-policy R18; contract: its context.md "T22b 제안 계약", which
 * Desktop's `src/sync/toolPolicyGrantControl.ts` already calls — keep the names and shapes).
 *
 * They ride the session's own encrypted RPC channel, so only someone who can open the conversation
 * reaches them; the server lane does not list them. A revoke only tightens, so it needs no further
 * confirmation. The daemon announces them with `grant-control` in the machine `toolPolicy` capability.
 *
 * The names carry no `:` because happy-server's managed scope refuses any such name outright. Managed
 * runs still do not get them: its `ALLOWED_RPC_NAMES` does not list them yet, so registration is
 * refused and the call comes back `RPC method not available` — which Desktop, like for a conversation
 * on an older CLI, reads as "not supported here". Listing them is a change to that server security
 * boundary (a separately approved plan), not to this file.
 */

import type { PolicyGrantRecord, PolicyGrantStore } from './grants';

export const TOOL_POLICY_GRANT_CONTROL = 'grant-control';
/** `{}` → `{ grants: PolicyGrantRecord[] }`, expired grants left out. */
export const TOOL_POLICY_GRANTS_RPC = 'tool-policy-grants';
/** `{ key }` → `{ revoked: boolean }` — false when the key had already expired or was never granted. */
export const TOOL_POLICY_REVOKE_GRANT_RPC = 'tool-policy-revoke-grant';

interface RpcRegistrar {
    registerHandler(method: string, handler: (params: any) => unknown): void;
}

export function registerToolPolicyGrantRpcs(rpc: RpcRegistrar, grants: PolicyGrantStore): void {
    rpc.registerHandler(TOOL_POLICY_GRANTS_RPC, async (): Promise<{ grants: PolicyGrantRecord[] }> => ({ grants: grants.list() }));
    rpc.registerHandler(TOOL_POLICY_REVOKE_GRANT_RPC, async (params: unknown): Promise<{ revoked: boolean }> => {
        const key = params && typeof params === 'object' ? (params as { key?: unknown }).key : undefined;
        if (typeof key !== 'string' || !key) throw new Error('Invalid grant key');
        return { revoked: grants.revoke(key) };
    });
}
