import { describe, expect, it, vi } from 'vitest';
import { createOrgEndpointSubagent, type OrgSubagentRecord, type OrgSubagentDependencies } from './orgEndpointSubagent';

function setup(options: { strict?: boolean; parent?: unknown; storedGeneration?: number; startThrows?: boolean } = {}) {
    const records = new Map<string, OrgSubagentRecord>();
    const calls = { start: 0, prepare: 0, sync: 0, session: 0, claim: 0 };
    const selection = { kind: 'org-endpoint' as const, bindingId: 'child-binding', endpointId: 'endpoint', generation: 3, candidates: ['target'] };
    const deps: OrgSubagentDependencies = {
        parent: async () => options.parent === undefined ? { sessionId: 'parent', launchId: 'root-launch', orgEndpoint: { endpointId: 'endpoint', generation: 3 } } : options.parent as never,
        strict: () => options.strict ?? false,
        localEndpoint: async () => ({ endpointId: 'endpoint', generation: options.storedGeneration ?? 3 }),
        journal: {
            reserve: async record => { const found = records.get(record.operationId); if (found) return { owner: false, record: found }; records.set(record.operationId, record); return { owner: true, record }; },
            read: async id => records.get(id) ?? null,
            write: async record => { records.set(record.operationId, structuredClone(record)); },
        },
        studio: async (_parent, path) => {
            if (path === 'prepare') { calls.prepare++; return { version: 1, state: 'prepared', selection, sync: { version: 1 } }; }
            if (path === 'launching') { calls.claim++; return { version: 1, state: 'launching', launchAuthorized: true }; }
            if (path === 'started') return { version: 1, state: 'started' };
            return { version: 1, state: 'unknown' };
        },
        sync: async () => { calls.sync++; },
        environment: async () => ({ targetId: 'target', environment: { HAPPY_AI_AUTH_SOURCE: 'org-endpoint' } }),
        createSession: async (_record, save) => { calls.session++; await save({ stableLaunch: 'child-binding' }); return { sessionId: 'child-session', snapshot: { stableLaunch: 'child-binding' } }; },
        start: async () => { calls.start++; if (options.startThrows) throw new Error('unconfirmed'); return { sessionId: 'child-session' }; },
        now: () => 1_800_000_000_000,
    };
    const runtime = createOrgEndpointSubagent(deps);
    const input = { operationId: 'operation', spawnId: 'spawn', sourceSessionId: 'parent', directory: '/project', agent: 'claude', initialPrompt: 'work' };
    return { runtime, input, deps, calls, records };
}

describe('org endpoint subagent execution', () => {
    it('returns pending at the absolute deadline and records a late confirmed start without resubmission', async () => {
        vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
        try {
            const ctx = setup(); ctx.deps.now = Date.now;
            let finish!: (value: { sessionId: string }) => void;
            ctx.deps.start = async () => { ctx.calls.start++; return new Promise(resolve => { finish = resolve; }); };
            const spawning = ctx.runtime.spawn(ctx.input);
            await vi.waitFor(() => expect(ctx.calls.start).toBe(1));
            await vi.advanceTimersByTimeAsync(620_000);
            expect(await spawning).toMatchObject({ ok: false, error: 'spawn_pending' });
            finish({ sessionId: 'child-session' });
            await vi.waitFor(() => expect(ctx.records.get('operation')?.phase).toBe('started'));
            expect(await ctx.runtime.status({ sourceSessionId: 'parent', operationId: 'operation' })).toMatchObject({ ok: true, sessionId: 'child-session' });
            expect(ctx.calls.start).toBe(1); expect(ctx.calls.prepare).toBe(1);
        } finally { vi.useRealTimers(); }
    });
    it('forwards a busy warning without imposing a new slot admission limit or exposing target identity', async () => {
        const ctx = setup(), original = ctx.deps.studio;
        ctx.deps.studio = async (parent, path, body) => {
            const answer = await original(parent, path, body);
            return path === 'prepare' ? { ...answer as object, displayName: 'Lab', warnings: ['ORG_LLM_ENDPOINT_BUSY'] } : answer;
        };
        const reply = await ctx.runtime.spawn(ctx.input);
        expect(reply).toMatchObject({ ok: true, displayName: 'Lab', warnings: ['ORG_LLM_ENDPOINT_BUSY'] });
        expect(ctx.calls.start).toBe(1); expect(JSON.stringify(reply)).not.toContain('target');
    });
    it('never submits a provider after the shared absolute deadline, and status remains an observation', async () => {
        const ctx = setup(), initial = ctx.deps.now(); let clock = initial;
        ctx.deps.now = () => clock;
        const original = ctx.deps.environment;
        ctx.deps.environment = async selection => { const result = await original(selection); clock += 620_001; return result; };
        await expect(ctx.runtime.spawn(ctx.input)).rejects.toMatchObject({ code: 'ORG_LLM_ENDPOINT_DEADLINE_EXCEEDED' });
        expect(ctx.calls.start).toBe(0); expect(ctx.calls.session).toBe(0);
        expect(await ctx.runtime.status({ sourceSessionId: 'parent', operationId: 'operation' })).toMatchObject({ ok: false });
        expect(ctx.calls.prepare).toBe(1);
    });
    it('preserves the existing structured-output object contract', async () => {
        const ctx = setup();
        expect(await ctx.runtime.spawn({ ...ctx.input, outputFormat: { type: 'json_schema', schema: { type: 'object', properties: {} } } })).toMatchObject({ ok: true });
    });
    it('returns a definite server refusal instead of hiding it as an uncertain start', async () => {
        const ctx = setup();
        ctx.deps.studio = async () => ({ version: 1, state: 'failed', reason: 'ORG_LLM_ENDPOINT_TOKEN_DELIVERY_UNSUPPORTED' });
        await expect(ctx.runtime.spawn(ctx.input)).rejects.toMatchObject({ code: 'ORG_LLM_ENDPOINT_TOKEN_DELIVERY_UNSUPPORTED' });
        expect(ctx.calls.start).toBe(0);
    });
    it('inherits the endpoint, uses a fresh binding, and launches one confirmed child', async () => {
        const ctx = setup();
        const result = await ctx.runtime.spawn(ctx.input);
        expect(result).toMatchObject({ ok: true, state: 'started', sessionId: 'child-session', endpointId: 'endpoint' });
        expect(ctx.calls).toEqual({ start: 1, prepare: 1, sync: 1, session: 1, claim: 1 });
        expect(await ctx.runtime.spawn(ctx.input)).toEqual(result);
        expect(ctx.calls.start).toBe(1);
    });
    it('rejects another endpoint and forbidden restore/worktree options before recording or preparing', async () => {
        for (const change of [{ endpointId: 'other' }, { agent: 'codex' }, { parentSessionId: 'parent' }, { resumeClaudeSessionId: 'native' }, { worktree: true }]) {
            const ctx = setup();
            await expect(ctx.runtime.spawn({ ...ctx.input, ...change })).rejects.toThrow();
            expect(ctx.calls.prepare).toBe(0); expect(ctx.calls.start).toBe(0); expect(ctx.records.size).toBe(0);
        }
    });
    it('refuses missing or corrupt parent evidence without default execution', async () => {
        for (const parent of [null, { sessionId: 'parent', launchId: '' }, { sessionId: 'other', launchId: 'launch' },
            { sessionId: 'parent', launchId: 'launch', orgEndpoint: { endpointId: 'endpoint' } }]) {
            const ctx = setup({ parent });
            await expect(ctx.runtime.spawn(ctx.input)).rejects.toThrow();
            expect(ctx.calls.start).toBe(0); expect(ctx.calls.prepare).toBe(0);
        }
    });
    it('requires explicit selection for a proven ordinary parent', async () => {
        const ctx = setup({ parent: { sessionId: 'parent', launchId: 'root-launch' } });
        await expect(ctx.runtime.spawn(ctx.input)).rejects.toThrow();
        expect(ctx.calls.prepare).toBe(0);
        expect(await ctx.runtime.spawn({ ...ctx.input, endpointId: 'endpoint' })).toMatchObject({ ok: true });
    });
    it('strict uses only the already synchronized generation and never applies an HTTP sync', async () => {
        const ctx = setup({ strict: true });
        expect(await ctx.runtime.spawn(ctx.input)).toMatchObject({ ok: true });
        expect(ctx.calls.sync).toBe(0);
        const stale = setup({ strict: true, storedGeneration: 2 });
        await expect(stale.runtime.spawn(stale.input)).rejects.toThrow();
        expect(stale.calls.prepare).toBe(0); expect(stale.calls.start).toBe(0);
    });
    it('refuses a prepared selection for another generation before provider execution', async () => {
        const ctx = setup(); const original = ctx.deps.studio;
        ctx.deps.studio = async (parent, path, body) => path === 'prepare'
            ? { version: 1, state: 'prepared', selection: { kind: 'org-endpoint', bindingId: 'new', endpointId: 'endpoint', generation: 4, candidates: ['target'] } }
            : original(parent, path, body);
        await expect(ctx.runtime.spawn(ctx.input)).rejects.toThrow();
        expect(ctx.calls.start).toBe(0); expect(ctx.calls.session).toBe(0);
    });
    it('never starts when launch authorization acknowledgement is missing', async () => {
        const ctx = setup(); const original = ctx.deps.studio;
        ctx.deps.studio = async (parent, path, body) => path === 'launching'
            ? { version: 1, state: 'launching' } : original(parent, path, body);
        expect(await ctx.runtime.spawn(ctx.input)).toMatchObject({ ok: false, error: 'spawn_pending' });
        expect(ctx.calls.start).toBe(0);
    });
    it('persists uncertain provider submission and never repeats it on retry or after restart', async () => {
        const ctx = setup({ startThrows: true });
        expect(await ctx.runtime.spawn(ctx.input)).toMatchObject({ ok: false, error: 'spawn_pending' });
        expect(await ctx.runtime.spawn(ctx.input)).toMatchObject({ ok: false, error: 'spawn_pending' });
        const restarted = createOrgEndpointSubagent(ctx.deps);
        expect(await restarted.spawn(ctx.input)).toMatchObject({ ok: false, error: 'spawn_pending' });
        expect(ctx.calls.start).toBe(1);
        expect(ctx.calls.prepare).toBe(1);
    });
    it('does not accept a changed payload for an existing operation', async () => {
        const ctx = setup(); await ctx.runtime.spawn(ctx.input);
        await expect(ctx.runtime.spawn({ ...ctx.input, initialPrompt: 'changed' })).rejects.toThrow();
        expect(ctx.calls.start).toBe(1);
    });
});
