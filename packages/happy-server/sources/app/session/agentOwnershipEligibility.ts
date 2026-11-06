import { z } from 'zod';
import { warn } from '@/utils/log';

// Asks A+ whether a Happy account on a machine is a personal Saycode user on a
// registered personal machine (aplus-dev-studio `POST /api/internal/agent-ownership/eligibility`).
// Desktop specs/reason-network-adoption/personal-ownership-simplification-plan.md §2·§8.
//
// A positive answer is never kept: withdrawal, company linking and registration
// deletion must close the next lookup. Negative and failed answers are held for a
// few seconds so one account bearer cannot amplify into A+ lookups. They fail closed.
export type AgentOwnershipEligibility = 'eligible' | 'ineligible' | 'unavailable';

const NEGATIVE_TTL_MS = 5_000;
const TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 4_096;
const answerSchema = z.object({ eligible: z.boolean(), reason: z.string().max(128) }).strict();

export function agentOwnershipRelationEnabled() {
    return process.env.SAYCODE_AGENT_OWNERSHIP_RELATION_ENABLED === '1';
}

export function createAgentOwnershipEligibility(deps: { fetch?: typeof fetch; now?: () => number } = {}) {
    const request = deps.fetch ?? fetch, now = deps.now ?? Date.now;
    const negative = new Map<string, { at: number; value: AgentOwnershipEligibility }>();

    async function ask(url: string, token: string, happyAccountId: string, machineId: string): Promise<AgentOwnershipEligibility> {
        let response: Response;
        try {
            response = await request(url, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
                headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
                body: JSON.stringify({ happyAccountId, machineId }),
            });
        } catch (error) {
            warn({ module: 'agent-ownership' }, 'eligibility request failed: ' + (error instanceof Error ? error.name : 'unknown'));
            return 'unavailable';
        }
        if (!response.ok) {
            warn({ module: 'agent-ownership' }, 'eligibility refused: HTTP ' + response.status);
            return 'unavailable';
        }
        try {
            if (!response.body) return 'unavailable';
            const reader = response.body.getReader();
            const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
            let size = 0;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value.byteLength > MAX_RESPONSE_BYTES - size) {
                        await reader.cancel();
                        return 'unavailable';
                    }
                    bytes.set(value, size);
                    size += value.byteLength;
                }
            } finally {
                reader.releaseLock();
            }
            const answer = answerSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))));
            if (!answer.success) return 'unavailable';
            return answer.data.eligible ? 'eligible' : 'ineligible';
        } catch {
            return 'unavailable';
        }
    }

    return async function read(happyAccountId: string, machineId: string): Promise<AgentOwnershipEligibility> {
        const url = process.env.SAYCODE_AGENT_OWNERSHIP_ELIGIBILITY_URL, token = process.env.SAYCODE_AGENT_OWNERSHIP_ELIGIBILITY_TOKEN;
        if (!url || !token) return 'unavailable';
        const key = happyAccountId + '\u0000' + machineId;
        const held = negative.get(key);
        if (held && now() - held.at < NEGATIVE_TTL_MS) return held.value;
        const value = await ask(url, token, happyAccountId, machineId);
        if (value === 'eligible') {
            negative.delete(key);
        } else {
            if (negative.size > 10_000) negative.clear();
            negative.set(key, { at: now(), value });
        }
        return value;
    };
}
