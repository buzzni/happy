/** The agent broker's personal sibling authority (Desktop reason-network personal-ownership-simplification-plan §5, H-C2).
 * Happy answers `POST /v1/session-ownership/relation` after asking A+ whether this account is a personal user on a
 * registered personal machine. The host fixes its own server, machine and token once at start; nothing comes from
 * the provider, request env or session metadata. Every inspection asks again: listing answers are not reused. */
import { z } from 'zod';
import type { AgentIdentityAuthority, AgentOwnershipVerdict } from './agentIdentityDescriptor';

export interface AgentRelationHost { serverUrl: string; machineId: string; token: string }
const MAX_BODY = 65_536;
const unknown = (reason: string): AgentOwnershipVerdict => ({ relation: 'unknown', proof: null, reason });
const answerSchema = z.union([
    z.object({ v: z.literal(1), callerAccountId: z.string().min(1), proof: z.null(), unavailable: z.literal(true) }).strict(),
    // v1 `own` means only personal account + registered personal machine + same account. Any other proof is rejected.
    z.object({ v: z.literal(1), callerAccountId: z.string().min(1), proof: z.literal('personal-same-account').nullable(),
        relations: z.record(z.string(), z.enum(['own', 'not-own'])) }).strict(),
]);

/** Read once when the host starts, before the provider: the daemon's server-confirmed machine id and this home's token. */
export async function readAgentRelationHost(input: { serverUrl: string;
    settings(): Promise<{ machineId?: string; machineIdConfirmedByServer?: boolean }>; credentials(): Promise<{ token: string } | null> }): Promise<AgentRelationHost | null> {
    try {
        const [settings, credentials] = await Promise.all([input.settings(), input.credentials()]);
        if (!settings.machineId || settings.machineIdConfirmedByServer !== true || !credentials?.token) return null;
        return { serverUrl: input.serverUrl, machineId: settings.machineId, token: credentials.token };
    } catch { return null; }
}

export function createAgentRelationAuthority(input: { host: AgentRelationHost | null; callerSessionId: string; fetch?: typeof fetch; timeoutMs?: number })
    : AgentIdentityAuthority & { inspectMany(ids: string[]): Promise<Record<string, AgentOwnershipVerdict>> } {
    const request = input.fetch ?? fetch;
    let account: Promise<string | null> | null = null;
    async function json(path: string, init: RequestInit = {}) {
        const host = input.host!;
        const response = await request(new URL(path, host.serverUrl).toString(), { ...init, redirect: 'error',
            signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
            headers: { authorization: 'Bearer ' + host.token, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
        if (!response.ok) throw new Error('relation-refused');
        const text = await response.text();
        if (text.length > MAX_BODY) throw new Error('relation-response-too-large');
        return JSON.parse(text) as unknown;
    }
    // A token's account never changes, so the host reads it once; a failed read is retried next time.
    const callerAccount = () => account ??= json('/v1/account/profile')
        .then(value => z.object({ id: z.string().min(1) }).parse(value).id)
        .catch(() => { account = null; return null; });
    async function inspectMany(ids: string[]): Promise<Record<string, AgentOwnershipVerdict>> {
        const targets = [...new Set(ids)];
        const all = (verdict: AgentOwnershipVerdict) => Object.fromEntries(targets.map(id => [id, verdict]));
        if (!input.host || !targets.length) return all(unknown('identity-unavailable'));
        try {
            const accountId = await callerAccount();
            if (!accountId) return all(unknown('identity-unavailable'));
            const parsed = answerSchema.safeParse(await json('/v1/session-ownership/relation', { method: 'POST',
                body: JSON.stringify({ v: 1, callerSessionId: input.callerSessionId, machineId: input.host.machineId, sessionIds: targets }) }));
            if (!parsed.success || parsed.data.callerAccountId !== accountId) return all(unknown('identity-unproven'));
            const answer = parsed.data;
            if ('unavailable' in answer) return all(unknown('ownership-unavailable'));
            const keys = Object.keys(answer.relations);
            if (keys.length !== targets.length || targets.some(id => !Object.hasOwn(answer.relations, id))) return all(unknown('identity-unproven'));
            if (answer.proof === null) return all(unknown('identity-unproven'));
            return Object.fromEntries(targets.map(id => [id, answer.relations[id] === 'own'
                ? { relation: 'own-sibling', proof: 'personal-same-account', reason: 'same-account' }
                : { relation: 'other', proof: null, reason: 'not-own' }]));
        } catch { return all(unknown('identity-unavailable')); }
    }
    return { inspectMany, async inspect(id) { return (await inspectMany([id]))[id] ?? unknown('identity-unavailable'); } };
}
