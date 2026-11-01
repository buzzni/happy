/** The broker's personal same-account inputs (Desktop identity-adapter-plan H-C, P0a §4.4). Every input comes from
 * the binding and trust the daemon issued over its private launch pipe — never request env, session metadata or
 * the provider. An input that cannot be proven throws, which the authority reads as unknown. */
import { createHash } from 'node:crypto';
import { MachineAgentIdentitySchema, ownershipFresh, rotationDecodeBinary, verifyOwnership } from '@slopus/happy-wire';
import type { AgentIdentityDependencies } from './agentIdentityDescriptor';

/** Not a Happy account id: ownership ids never contain whitespace, so this never equals the caller's account. */
export const OTHER_ACCOUNT = 'other account';
const MAX_BODY = 65_536;

export function createAgentIdentityAdapter(input: {
    binding: { machineId: string; happyAccountId: string; hostEpoch: string };
    trust: { issuer: string; audience: string; publicKeys: Record<string, string>; lookupOrigin: string };
    /** This daemon's Happy server origin; the descriptor audience must be it. */
    happyOrigin: string;
    /** Whether the daemon still vouches for the binding; checked before every request. */
    current(): Promise<boolean>;
    token(): Promise<string | null>;
    fetch?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
}): AgentIdentityDependencies {
    const fetchImpl = input.fetch ?? fetch, now = input.now ?? Date.now, { binding, trust } = input;
    const post = async (url: URL, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
        const token = await input.token();
        if (!token || !await input.current()) throw new Error('identity-binding-unavailable');
        const response = await fetchImpl(url.toString(), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const text = await response.text();
        if (text.length > MAX_BODY) throw new Error('identity-response-too-large');
        const json = JSON.parse(text);
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('identity-response-invalid');
        return { status: response.status, json };
    };
    return {
        readState: () => ({ machineId: binding.machineId, happyAccountId: binding.happyAccountId, epoch: binding.hostEpoch }),
        fetchDescriptor: async state => {
            const { status, json } = await post(new URL(`/api/v2/machines/${encodeURIComponent(state.machineId)}/agent-identity`, trust.lookupOrigin), {});
            if (status !== 200) throw new Error('identity-descriptor-unavailable');
            return json.descriptor;
        },
        verifyDescriptor: async raw => {
            const parsed = MachineAgentIdentitySchema.safeParse(raw);
            if (!parsed.success) return false;
            const descriptor = parsed.data;
            if (descriptor.issuer !== trust.issuer || descriptor.audience !== trust.audience || trust.audience !== input.happyOrigin) return false;
            const encoded = Object.hasOwn(trust.publicKeys, descriptor.keyId) ? trust.publicKeys[descriptor.keyId] : undefined;
            let key: Uint8Array;
            try { key = rotationDecodeBinary(encoded ?? '', 32); } catch { return false; }
            // A pinned key is trusted only under its own hash, so a keyId cannot borrow another key.
            if (createHash('sha256').update(key).digest('hex') !== descriptor.keyId) return false;
            return ownershipFresh(descriptor, now()) && verifyOwnership(descriptor, key);
        },
        targetAccount: async (targetSessionId, state) => {
            const { status, json } = await post(new URL('/v1/session-ownership/same-account', input.happyOrigin), { sessionId: targetSessionId });
            // An older server (404) or any other answer cannot prove ownership either way.
            if (status !== 200 || typeof json.sameAccount !== 'boolean') return null;
            return json.sameAccount ? state.happyAccountId : OTHER_ACCOUNT;
        },
        now,
    };
}
