import type { createOrgSubagentRuntime } from './orgEndpointSubagentRuntime';
import { ZodError } from 'zod';

/** Machine-key lane only; neither server nor linked-machine delegation can create execution authority. */
export function registerOrgSubagentRpc(register: (method: string, handler: (raw: unknown) => Promise<unknown>) => void,
    runtime?: ReturnType<typeof createOrgSubagentRuntime>) {
    register('org-endpoint-subagent-capabilities', raw => runtime?.capabilities(raw) ?? Promise.resolve({ orgEndpointSubagentVersion: 0 }));
    if (!runtime) return;
    for (const [name, handler] of [
        ['org-endpoint-subagent-context', runtime.context], ['spawn-org-endpoint-subagent', runtime.spawn],
        ['org-endpoint-subagent-status', runtime.status], ['org-endpoint-subagent-root-prepare', runtime.prepareRoot],
        ['org-endpoint-subagent-root-start', runtime.startRoot], ['org-endpoint-subagent-root-status', runtime.statusRoot],
    ] as const) register(name, async raw => {
        try { return await handler(raw); }
        catch (error) {
            const refusal = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^ORG_LLM_ENDPOINT_[A-Z0-9_]+$/.test(error.code) ? error.code : null;
            if (name === 'org-endpoint-subagent-root-start' && !refusal && !(error instanceof ZodError)) {
                return { version: 1, type: 'error', code: 'ORG_LLM_ENDPOINT_ROOT_START_UNCONFIRMED' };
            }
            if (!(error instanceof ZodError) && (name === 'spawn-org-endpoint-subagent' || name === 'org-endpoint-subagent-status')
                && !refusal) {
                const operationId = raw && typeof raw === 'object' && 'operationId' in raw && typeof raw.operationId === 'string'
                    && /^[A-Za-z0-9_-]{1,128}$/.test(raw.operationId) ? raw.operationId : undefined;
                return { ok: false, error: 'spawn_pending', reason: 'ORG_LLM_ENDPOINT_EXECUTION_UNCONFIRMED', ...(operationId ? { operationId } : {}) };
            }
            const code = refusal ?? (error instanceof ZodError ? 'ORG_LLM_ENDPOINT_INVALID_INPUT' : 'ORG_LLM_ENDPOINT_VERIFICATION_UNAVAILABLE');
            return { ok: false, error: code, reason: code };
        }
    });
}
