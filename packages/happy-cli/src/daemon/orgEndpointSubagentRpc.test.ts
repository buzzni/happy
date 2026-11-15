import { describe, expect, it } from 'vitest';
import { registerOrgSubagentRpc } from './orgEndpointSubagentRpc';
import { SERVER_LANE_METHODS } from '@/api/rpc/serverLane';
import { DELEGATION_LANE_METHODS } from '@/api/rpc/delegationLane';

describe('org subagent machine RPC', () => {
    it('keeps a filesystem or transport failure unsettled instead of claiming no child was created', async () => {
        const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
        const runtime = { spawn: async () => { throw Object.assign(new Error('private-path'), { code: 'EACCES' }); } } as unknown as Parameters<typeof registerOrgSubagentRpc>[1];
        registerOrgSubagentRpc((name, handler) => handlers.set(name, handler), runtime);
        const reply = await handlers.get('spawn-org-endpoint-subagent')!({ operationId: 'operation' });
        expect(reply).toMatchObject({ ok: false, error: 'spawn_pending', operationId: 'operation' });
        expect(JSON.stringify(reply)).not.toContain('private-path');
    });
    it('advertises unsupported without installing any creation handler', async () => {
        const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
        registerOrgSubagentRpc((name, handler) => handlers.set(name, handler));
        expect([...handlers.keys()]).toEqual(['org-endpoint-subagent-capabilities']);
        expect(await handlers.get('org-endpoint-subagent-capabilities')!({})).toEqual({ orgEndpointSubagentVersion: 0 });
    });
    it('never allows the server lane to invoke the new creation or proof routes', () => {
        for (const method of ['spawn-org-endpoint-subagent', 'org-endpoint-subagent-root-prepare', 'org-endpoint-subagent-root-start', 'org-endpoint-subagent-context'])
            expect([SERVER_LANE_METHODS.has(method), DELEGATION_LANE_METHODS.has(method)]).toEqual([false, false]);
    });
});
