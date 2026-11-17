import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentState } from '@/api/types';
import { createLiteRuntimeTurnGate, createSessionOrgRequirementsGate, liteRuntimeAgent } from './sessionGate';
import { ORG_SCOPE_HINT_ENV } from './gate';

const doc = (items: Record<string, unknown>) => ({ schemaVersion: 1, companyId: 'c1', revision: 2, modelPolicyUpdatedAt: null, issuedAt: 1, items });

function stubStudio(items: Record<string, unknown>, delay = 0) {
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', 'http://studio.test/api/me/mcp-config');
    const fetchMock = vi.fn(async () => {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        return new Response(JSON.stringify({ mcpServers: {}, requirementsStatus: 'ok', requirements: doc(items) }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function session() {
    let state: AgentState = {};
    return { sessionId: 's1', updateAgentState: (update: (current: AgentState) => AgentState) => { state = update(state); }, state: () => state };
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('session gate assembly', () => {
    it('keeps opencode apart from an ACP agent Studio has no key for', () => {
        expect(liteRuntimeAgent('opencode')).toBe('opencode');
        expect(liteRuntimeAgent('grok')).toBe('grok');
        expect(liteRuntimeAgent('some-acp-agent')).toBe('acp');
    });

    it('makes no gate for a managed run or with the switch off, and still drops the project hint', () => {
        const env: NodeJS.ProcessEnv = { [ORG_SCOPE_HINT_ENV]: 'p1' };
        expect(createSessionOrgRequirementsGate({ agent: 'claude', credentials: null, machineId: 'm', session: session(), env })).toBeNull();
        expect(env[ORG_SCOPE_HINT_ENV]).toBeUndefined();
        expect(createSessionOrgRequirementsGate({ agent: 'claude', credentials: { token: 't' }, machineId: 'm', session: session(), env: { HAPPY_ORG_REQUIREMENTS: 'off' } })).toBeNull();
    });

    it('publishes the agentState field only once there is something to say', async () => {
        stubStudio({ 'permissions.mode': { kind: 'ceiling', max: 'default' } });
        const s = session();
        const org = createSessionOrgRequirementsGate({ agent: 'codex', credentials: { token: 't' }, machineId: 'm', session: s })!;
        expect(s.state()).toEqual({});
        await org.lookup();
        expect(s.state().orgRequirements).toEqual({ state: 'ok', revision: 2 });
    });

    it('passes the verified plan model to the session gate without relaxing ordinary sessions', async () => {
        stubStudio({ 'ai.models': { kind: 'allowedSet', values: ['claude:claude-opus-5-5'], default: null, source: 'member' } });
        const planModel = 'deepseek/deepseek-v4.1-flash-eco';
        const input = { agent: 'claude' as const, credentials: { token: 't' }, machineId: 'm', session: session() };
        const plan = createSessionOrgRequirementsGate({ ...input, planModel })!;
        const ordinary = createSessionOrgRequirementsGate({ ...input, session: { ...session(), sessionId: 'ordinary' } })!;
        await plan.lookup();
        await ordinary.lookup();
        const turn = { permissionMode: 'default', model: planModel, modelOrigin: 'explicit' as const };
        expect(plan.gate.checkTurn(turn)).toMatchObject({ kind: 'run' });
        expect(ordinary.gate.checkTurn(turn)).toMatchObject({ kind: 'refuse' });
    });

    it('leaves an organization endpoint session model to its binding and still applies the ceiling', async () => {
        stubStudio({
            'ai.models': { kind: 'allowedSet', values: ['claude:claude-opus-5-5'], default: null, source: 'member' },
            'permissions.mode': { kind: 'ceiling', max: 'default' },
        });
        const input = { agent: 'claude' as const, credentials: { token: 't' }, machineId: 'm' };
        const endpoint = createSessionOrgRequirementsGate({ ...input, session: session(), env: { HAPPY_AI_AUTH_SOURCE: 'org-endpoint' } })!;
        const personal = createSessionOrgRequirementsGate({ ...input, session: { ...session(), sessionId: 'personal' }, env: { HAPPY_AI_AUTH_SOURCE: 'personal-endpoint' } })!;
        await endpoint.lookup();
        await personal.lookup();
        const turn = { permissionMode: 'bypassPermissions', model: 'deepseek/deepseek-v4.1-flash-eco', modelOrigin: 'explicit' as const };
        const verdict = endpoint.gate.checkTurn(turn);
        expect(verdict).toMatchObject({ kind: 'run', permissionMode: 'default', modeClamped: true });
        expect(verdict).not.toHaveProperty('substituteModel');
        expect(endpoint.gate.modelAllowed('claude-sonnet-5-5')).toBe(true);
        expect(personal.gate.restrictsModels()).toBe(true);
        expect(personal.gate.checkTurn(turn)).toMatchObject({ kind: 'refuse' });
    });
});

describe('runtimes without a ceiling or tool-rule gate (R10.7)', () => {
    it('runs every turn as before without an organization gate', async () => {
        await expect(createLiteRuntimeTurnGate(null)({ model: 'gemini-2.5-pro' })).resolves.toEqual({ kind: 'run' });
    });

    it('refuses every turn while a ceiling applies, after waiting for the first lookup', async () => {
        const fetchMock = stubStudio({ 'permissions.mode': { kind: 'ceiling', max: 'acceptEdits' } }, 20);
        const org = createSessionOrgRequirementsGate({ agent: 'gemini', credentials: { token: 't' }, machineId: 'm', session: session() });
        const turn = createLiteRuntimeTurnGate(org);
        await expect(turn({ model: 'gemini-2.5-pro' })).resolves.toMatchObject({ kind: 'refuse', message: expect.stringContaining('지킬 수 없어') });
        await expect(turn({})).resolves.toMatchObject({ kind: 'refuse' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('judges only the model when nothing else applies', async () => {
        stubStudio({ 'ai.models': { kind: 'allowedSet', values: ['gemini:gemini-2.5-flash', 'grok:*'], default: null, source: 'organization' } });
        const gemini = createLiteRuntimeTurnGate(createSessionOrgRequirementsGate({ agent: 'gemini', credentials: { token: 't' }, machineId: 'm', session: session() }));
        await expect(gemini({ model: 'gemini-2.5-pro' })).resolves.toMatchObject({ kind: 'refuse' });
        await expect(gemini({ model: 'gemini-2.5-flash' })).resolves.toEqual({ kind: 'run' });
        await expect(gemini({})).resolves.toEqual({ kind: 'run', substituteModel: 'gemini-2.5-flash' });
        const grok = createLiteRuntimeTurnGate(createSessionOrgRequirementsGate({ agent: 'grok', credentials: { token: 't' }, machineId: 'm', session: session() }));
        await expect(grok({})).resolves.toEqual({ kind: 'run' });
    });
});
