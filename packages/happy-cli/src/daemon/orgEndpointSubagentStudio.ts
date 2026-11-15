/** Device-signed calls to the trusted Studio. No identity, endpoint URL or credential is taken from provider input. */
import { randomBytes } from 'node:crypto';
import { RotationOriginSchema, SignedSubagentRequestSchema, SUBAGENT_PATHS, signSubagentRequest } from '@slopus/happy-wire';
import { OrgSubagentRefused, type OrgSubagentParent } from './orgEndpointSubagent';

const paths = { prepare: SUBAGENT_PATHS.prepare, status: SUBAGENT_PATHS.status, failure: SUBAGENT_PATHS.failure,
    started: SUBAGENT_PATHS.started, launching: SUBAGENT_PATHS.launching, 'child-ticket': SUBAGENT_PATHS.childTicket,
    capabilities: SUBAGENT_PATHS.capabilities, resume: SUBAGENT_PATHS.resume };
export type OrgSubagentStudioAction = keyof typeof paths;

export function createOrgSubagentStudio(deps: {
    origin: string; machineId: string; signingKey: Uint8Array; bearer(): string; fetch: typeof fetch;
    now?: () => number; remainingMs?: () => number;
}) {
    const origin = RotationOriginSchema.parse(deps.origin), now = deps.now ?? Date.now;
    return async (parent: OrgSubagentParent, action: OrgSubagentStudioAction, payload: Record<string, unknown>): Promise<unknown> => {
        const path = paths[action];
        const time = now(), timeout = Math.min(action === 'prepare' ? 70_000 : 10_000, deps.remainingMs?.() ?? Infinity);
        if (timeout <= 0) throw new Error('ORG_LLM_ENDPOINT_DEADLINE_EXCEEDED');
        const body = { ...payload, version: 1, type: 'org-llm-subagent-request', method: 'POST', audience: origin,
            path, machineId: deps.machineId, sourceSessionId: parent.sessionId, launchId: parent.launchId,
            nonce: randomBytes(32).toString('hex'), issuedAt: time, expiresAt: time + 60_000 };
        const signed = SignedSubagentRequestSchema.parse(signSubagentRequest(body, deps.signingKey));
        let response: Response;
        try {
            response = await deps.fetch(origin + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
                headers: { Authorization: `Bearer ${deps.bearer()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(signed) });
        } catch { throw new Error('ORG_LLM_ENDPOINT_STUDIO_UNREACHABLE'); }
        const missingRoute = response.status === 404 || response.status === 405;
        if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
            await response.body?.cancel(); throw new OrgSubagentRefused(missingRoute ? 'ORG_LLM_ENDPOINT_SERVER_UNSUPPORTED' : 'ORG_LLM_ENDPOINT_SERVER_RESPONSE_INVALID');
        }
        const reader = response.body?.getReader(); if (!reader) throw new OrgSubagentRefused('ORG_LLM_ENDPOINT_SERVER_RESPONSE_INVALID');
        const chunks: Uint8Array[] = []; let bytes = 0;
        try {
            for (;;) {
                const chunk = await reader.read(); if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > 128 * 1024) { await reader.cancel(); throw new OrgSubagentRefused('ORG_LLM_ENDPOINT_SERVER_RESPONSE_TOO_LARGE'); }
                chunks.push(chunk.value);
            }
        } finally { reader.releaseLock(); }
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new OrgSubagentRefused('ORG_LLM_ENDPOINT_SERVER_RESPONSE_INVALID'); }
        const value = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
        if (!response.ok) {
            const safe = typeof value?.error === 'string' && /^ORG_LLM_ENDPOINT_[A-Z0-9_]{1,100}$/.test(value.error) ? value.error
                : missingRoute ? 'ORG_LLM_ENDPOINT_SERVER_UNSUPPORTED' : response.status === 401 || response.status === 403 ? 'ORG_LLM_ENDPOINT_PROOF_FORBIDDEN' : 'ORG_LLM_ENDPOINT_STUDIO_UNAVAILABLE';
            if (response.status >= 500 || response.status === 429) throw new Error(safe);
            throw new OrgSubagentRefused(safe);
        }
        if (value?.version !== 1) throw new OrgSubagentRefused('ORG_LLM_ENDPOINT_SERVER_RESPONSE_INVALID');
        return value;
    };
}
