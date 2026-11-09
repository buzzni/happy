import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { queryWithPinnedCredential, queryWithPinnedEndpoint } from './credentialPin';
import { buildOrgLlmEndpointEnvironment, parseOrgLlmEndpointSync } from '@/daemon/orgLlmEndpoint';
import { ORG_ENDPOINT_CLEARED_ENV_KEYS, ORG_ENDPOINT_OWNED_ENV_KEYS } from '../utils/orgEndpointEnvKeys';
import { describeClaudeLaunchFailure } from '../utils/launchFailureMessage';
import { logger } from '@/lib';
const TOKEN = 'fixture-owner-token';
function fixture() {
    let effective: Record<string, any> = { apiKeyHelper: 'wrong helper', env: { CLAUDE_CODE_OAUTH_TOKEN: 'wrong' } };
    const received: SDKUserMessage[] = [];
    const controls = {
        initializationResult: vi.fn(async () => ({ claude_code_version: '2.1.308', hooks_applied: true })),
        getSettings: vi.fn(async () => ({ effective, sources: [{ source: 'flagSettings', settings: { env: { KEEP_FLAG_ENV: 'yes' }, permissions: { deny: ['Bash(deploy)'] } } }] })),
        applyFlagSettings: vi.fn(async (settings: Record<string, any>) => { effective = { ...effective, ...settings }; }),
        reinitialize: vi.fn(async () => ({ account: { apiProvider: 'firstParty' as string, tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' } })),
        request: vi.fn(async () => ({ response: {} })),
        close: vi.fn(),
    };
    const create = vi.fn(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => Object.assign((async function* () {
        for await (const message of prompt) { received.push(message); yield { type: 'result', subtype: 'success' }; }
    })(), controls) as unknown as Query);
    return { controls, create, received, tamper: () => { effective.env.ANTHROPIC_BASE_URL = 'https://wrong.example.test'; },
        setEffective: (value: Record<string, any>) => { effective = { ...effective, ...value }; },
        setEnv: (patch: Record<string, string>) => { effective.env = { ...effective.env, ...patch }; },
        setAllowedProviders: (value: string[]) => { effective.allowedProviders = value; }, restrictOrganization: () => { effective.forceLoginOrgUUID = 'fixture-org'; } };
}
const options: Options = { env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, settingSources: ['user', 'project', 'local'] };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('pinned credential at the SDK request boundary', () => {
    it('applies only credential flags before input, preserving settings sources and existing flag env', async () => {
        const f = fixture(); const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options }, TOKEN);
        await q.next();
        expect(f.controls.applyFlagSettings).toHaveBeenCalledOnce();
        expect(f.controls.applyFlagSettings.mock.calls[0][0]).toMatchObject({ apiKeyHelper: '', env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: '', KEEP_FLAG_ENV: 'yes' } });
        expect(Object.keys(f.controls.applyFlagSettings.mock.calls[0][0]).sort()).toEqual(['apiKeyHelper', 'env']);
        // The socket route changes the transport under an unchanged address and token; it is forced empty like the other routes.
        expect(f.controls.applyFlagSettings.mock.calls[0][0]).toMatchObject({ env: { ANTHROPIC_UNIX_SOCKET: '' } });
        expect(f.create.mock.calls[0][0]).toMatchObject({ options });
        expect(f.received).toHaveLength(1); expect(f.received[0].message.content).toBe('hello');
    });
    it.each(['missing-control', 'old-version', 'new-minor', 'new-major', 'overlay-refused', 'managed-override', 'wrong-account', 'restricted-org', 'aborted'])(
        'refuses %s before input and exposes a sanitized failure', async kind => {
            const f = fixture();
            if (kind === 'missing-control') f.controls.getSettings = undefined as never;
            if (kind === 'old-version') f.controls.initializationResult.mockResolvedValue({ claude_code_version: '2.1.100', hooks_applied: true });
            if (kind === 'new-minor') f.controls.initializationResult.mockResolvedValue({ claude_code_version: '2.2.0', hooks_applied: true });
            if (kind === 'new-major') f.controls.initializationResult.mockResolvedValue({ claude_code_version: '3.0.0', hooks_applied: true });
            if (kind === 'overlay-refused') f.controls.applyFlagSettings.mockRejectedValue(new Error(TOKEN));
            if (kind === 'managed-override') f.controls.applyFlagSettings.mockImplementation(async () => {});
            if (kind === 'restricted-org') f.restrictOrganization();
            if (kind === 'wrong-account') f.controls.reinitialize.mockResolvedValue({ account: { apiProvider: 'bedrock', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' } });
            const abortController = new AbortController(); if (kind === 'aborted') abortController.abort();
            const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options: { ...options, abortController } }, TOKEN);
            await expect(q.next()).rejects.toThrow(kind === 'aborted' ? 'Claude request aborted' : 'CLAUDE_PERSONAL_AUTH_NOT_VERIFIED');
            expect(f.received).toEqual([]); expect(f.controls.close).toHaveBeenCalled();
        },
    );
    it('rechecks later input instead of trusting the initialization snapshot', async () => {
        const f = fixture();
        async function* prompt() { for (const content of ['one', 'two']) yield { type: 'user' as const, parent_tool_use_id: null, message: { role: 'user' as const, content } }; }
        const q = queryWithPinnedCredential(f.create as never, { prompt: prompt(), options }, TOKEN);
        await q.next(); f.tamper();
        await expect(q.next()).rejects.toThrow('CLAUDE_PERSONAL_AUTH_NOT_VERIFIED');
        expect(f.received).toHaveLength(1);
    });
    it('preserves an authority refusal from the trusted input producer', async () => {
        const f = fixture(); const refusal = new Error('trusted authority refusal');
        async function* prompt(): AsyncGenerator<SDKUserMessage> { throw refusal; }
        const q = queryWithPinnedCredential(f.create as never, { prompt: prompt(), options }, TOKEN);
        await expect(q.next()).rejects.toBe(refusal);
        expect(f.received).toEqual([]);
    });
    it('checks side-question control requests and refuses a later auth change', async () => {
        const f = fixture(); const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options }, TOKEN);
        await q.next();
        const request = (q as unknown as {request(body: unknown): Promise<unknown>}).request;
        await request({ subtype: 'side_question', prompt: 'one' });
        expect(f.controls.request).toHaveBeenCalledOnce(); f.tamper();
        await expect(request({ subtype: 'side_question', prompt: 'two' })).rejects.toThrow('CLAUDE_PERSONAL_AUTH_NOT_VERIFIED');
        expect(f.controls.request).toHaveBeenCalledOnce();
    });
    it.each(['missing-control', 'restricted-org', 'later-change'])('refuses organization %s with a source-specific sanitized error', async kind => {
        const f = fixture();
        if (kind === 'missing-control') f.controls.getSettings = undefined as never;
        if (kind === 'restricted-org') f.restrictOrganization();
        const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options }, TOKEN, 'organization');
        if (kind === 'later-change') { await q.next(); f.tamper(); }
        if (kind === 'later-change') await expect((q as unknown as {request(body: unknown): Promise<unknown>}).request({ subtype: 'side_question' })).rejects.toThrow('CLAUDE_ORGANIZATION_AUTH_NOT_VERIFIED');
        else await expect(q.next()).rejects.toThrow('CLAUDE_ORGANIZATION_AUTH_NOT_VERIFIED');
        expect(f.received).toHaveLength(kind === 'later-change' ? 1 : 0);
        expect(f.controls.close).toHaveBeenCalled();
    });
    it('bounds a hung control call without sending input', async () => {
        vi.useFakeTimers(); const f = fixture();
        f.controls.getSettings.mockImplementation(() => new Promise(() => {}));
        const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options }, TOKEN);
        const checked = expect(q.next()).rejects.toThrow('CLAUDE_PERSONAL_AUTH_NOT_VERIFIED');
        await vi.advanceTimersByTimeAsync(10_001); await checked;
        expect(f.received).toEqual([]); expect(f.controls.close).toHaveBeenCalled();
    });
    // A slow SessionStart hook delays initialization only; no input exists until it resolves.
    it('waits past the control timeout for Claude Code to finish starting', async () => {
        vi.useFakeTimers(); const f = fixture();
        f.controls.initializationResult.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ claude_code_version: '2.1.308', hooks_applied: true }), 12_000)));
        const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options }, TOKEN, 'organization');
        const first = q.next();
        await vi.advanceTimersByTimeAsync(12_001);
        await expect(first).resolves.toMatchObject({ done: false });
        expect(f.received).toHaveLength(1);
    });
    it('refuses without input when Claude Code does not finish starting within the startup budget', async () => {
        vi.useFakeTimers(); const f = fixture();
        f.controls.initializationResult.mockImplementation(() => new Promise(() => {}));
        const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options }, TOKEN, 'organization');
        let settled = false;
        const checked = q.next().then(() => { throw new Error('unexpected input'); }, (error: unknown) => { settled = true; return error; });
        await vi.advanceTimersByTimeAsync(59_000); expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1_001);
        const error = await checked;
        expect(error).toMatchObject({ message: 'CLAUDE_ORGANIZATION_AUTH_NOT_VERIFIED', stage: 'initialize', reason: 'timeout' });
        expect(f.received).toEqual([]); expect(f.controls.close).toHaveBeenCalled();
    });
    it('ends a startup wait as an abort when the user stops', async () => {
        vi.useFakeTimers(); const f = fixture(); const abortController = new AbortController();
        f.controls.initializationResult.mockImplementation(() => new Promise(() => {}));
        const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options: { ...options, abortController } }, TOKEN, 'organization');
        const checked = expect(q.next()).rejects.toThrow('Claude request aborted');
        await vi.advanceTimersByTimeAsync(15_000); abortController.abort(); await checked;
        expect(f.received).toEqual([]);
    });
    it('logs startup hook timing and the refused stage without hook output or credentials', async () => {
        vi.useFakeTimers(); const f = fixture(); const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        f.controls.initializationResult.mockImplementation(() => new Promise(() => {}));
        const hook = { type: 'system', hook_event: 'SessionStart', hook_id: 'h1', hook_name: 'SessionStart:startup' };
        const create = vi.fn(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => Object.assign((async function* () {
            // Like the SDK, consume input on its own while the output stream reports hooks.
            void (async () => { try { for await (const message of prompt) f.received.push(message); } catch { /* refused */ } })();
            yield { ...hook, subtype: 'hook_started' };
            await new Promise(resolve => setTimeout(resolve, 7_000));
            yield { ...hook, subtype: 'hook_response', outcome: 'success', output: TOKEN, stdout: TOKEN, stderr: '' };
            await new Promise(() => {});
        })(), f.controls) as unknown as Query);
        const q = queryWithPinnedCredential(create as never, { prompt: 'hello', options }, TOKEN, 'organization');
        await q.next();
        const second = q.next();
        await vi.advanceTimersByTimeAsync(7_001); await second;
        const third = q.next().catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(60_000); await third;
        const lines = debug.mock.calls.map(call => call.join(' ')).join('\n');
        expect(lines).toMatch(/SessionStart:startup hook started at \+\d+ms/);
        expect(lines).toMatch(/SessionStart:startup hook success at \+7\d{3}ms after 7\d{3}ms/);
        expect(lines).toMatch(/initialize timeout after 60000ms/);
        expect(lines).toMatch(/organization credential refused: stage=initialize reason=timeout \d+ms after query start/);
        expect(lines).not.toContain(TOKEN);
    });
    it('logs a failed recheck with the duration of that call, not the conversation age', async () => {
        vi.useFakeTimers(); const f = fixture(); const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        async function* prompt() { for (const content of ['one', 'two']) { yield { type: 'user' as const, parent_tool_use_id: null, message: { role: 'user' as const, content } }; await new Promise(resolve => setTimeout(resolve, 600_000)); } }
        const q = queryWithPinnedCredential(f.create as never, { prompt: prompt(), options }, TOKEN, 'organization');
        await q.next();
        f.controls.reinitialize.mockImplementation(() => new Promise(() => {}));
        const second = q.next().catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(610_001);
        expect(await second).toMatchObject({ stage: 'recheck', reason: 'timeout' });
        const lines = debug.mock.calls.map(call => call.join(' ')).join('\n');
        expect(lines).toMatch(/recheck timeout after 10000ms/);
        expect(lines.match(/credential refused/g)).toHaveLength(1);
    });
    it.each([
        ['getSettings-hang', 'settings', 'timeout'],
        ['apply-hang', 'apply', 'timeout'],
        ['recheck-hang', 'recheck', 'timeout'],
        ['missing-control', 'initialize', 'unsupported'],
        ['old-version', 'initialize', 'unsupported'],
        ['overlay-refused', 'apply', 'control_failed'],
        ['managed-override', 'recheck', 'mismatch'],
        ['wrong-account', 'recheck', 'mismatch'],
        ['restricted-org', 'recheck', 'policy'],
    ])('reports %s as stage %s / reason %s without upstream detail', async (kind, stage, reason) => {
        vi.useFakeTimers(); const f = fixture();
        if (kind === 'getSettings-hang') f.controls.getSettings.mockImplementation(() => new Promise(() => {}));
        if (kind === 'apply-hang') f.controls.applyFlagSettings.mockImplementation(() => new Promise(() => {}));
        if (kind === 'recheck-hang') f.controls.reinitialize.mockImplementation(() => new Promise(() => {}));
        if (kind === 'missing-control') f.controls.applyFlagSettings = undefined as never;
        if (kind === 'old-version') f.controls.initializationResult.mockResolvedValue({ claude_code_version: '2.1.100', hooks_applied: true });
        if (kind === 'overlay-refused') f.controls.applyFlagSettings.mockRejectedValue(new Error(TOKEN));
        if (kind === 'managed-override') f.controls.applyFlagSettings.mockImplementation(async () => {});
        if (kind === 'wrong-account') f.controls.reinitialize.mockResolvedValue({ account: { apiProvider: 'bedrock', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' } });
        if (kind === 'restricted-org') f.restrictOrganization();
        const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options }, TOKEN, 'organization');
        const checked = q.next().then(() => { throw new Error('unexpected input'); }, (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(10_001);
        const error = await checked as Error & { stage?: string; reason?: string };
        expect(error).toMatchObject({ message: 'CLAUDE_ORGANIZATION_AUTH_NOT_VERIFIED', stage, reason });
        expect(JSON.stringify({ ...error, message: error.message })).not.toContain(TOKEN);
        expect(f.received).toEqual([]);
    });
});

// aplus specs/org-llm-endpoints r2 — an endpoint session's address, token and models must survive the settings files.
describe('pinned organization LLM endpoint at the SDK request boundary', () => {
    const entry = parseOrgLlmEndpointSync({
        version: 1, companyId: 'company-1', userId: 'user-1',
        endpoint: { id: 'endpoint-1', generation: 2, model: 'corp-model', models: { opus: 'corp-big' }, maxContextTokens: 200_000, apiTimeoutMs: 600_000,
            authMode: 'static-token', token: 'corp-endpoint-token', targets: [{ id: 'target-a', url: 'https://llm-a.corp.example' }] },
    });
    // The daemon's own builder: the pin must accept what the daemon really hands a session.
    const daemonEnv = buildOrgLlmEndpointEnvironment({ entry, target: entry.targets[0]!, bindingId: 'binding-1' });
    const endpointOptions: Options = { env: daemonEnv, settingSources: ['user', 'project', 'local'] };
    const CODE = 'CLAUDE_ORG_ENDPOINT_NOT_VERIFIED';
    const endpointAccount = { account: { apiProvider: 'firstParty', tokenSource: 'ANTHROPIC_AUTH_TOKEN' } };
    // Claude Code reports a bearer-token endpoint this way (observed with the real SDK).
    const endpointFixture = () => { const f = fixture(); f.controls.reinitialize.mockResolvedValue(endpointAccount as never); return f; };

    it('forces the address, token, models and every cleared route above the settings files, keeping flag env', async () => {
        const f = endpointFixture(); const q = queryWithPinnedEndpoint(f.create as never, { prompt: 'hello', options: endpointOptions }, daemonEnv);
        await q.next();
        const applied = f.controls.applyFlagSettings.mock.calls[0][0] as { apiKeyHelper: string; env: Record<string, string> };
        expect(applied.apiKeyHelper).toBe('');
        expect(applied.env).toMatchObject({
            KEEP_FLAG_ENV: 'yes', ANTHROPIC_BASE_URL: 'https://llm-a.corp.example', ANTHROPIC_AUTH_TOKEN: 'corp-endpoint-token',
            ANTHROPIC_MODEL: 'corp-model', ANTHROPIC_DEFAULT_OPUS_MODEL: 'corp-big', CLAUDE_CODE_SUBAGENT_MODEL: 'corp-model',
            CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_USE_MANTLE: '', ANTHROPIC_PROFILE: '', ANTHROPIC_UNIX_SOCKET: '',
        });
        // Exactly the daemon's non-marker keys, nothing the settings files could add.
        expect(Object.keys(applied.env).filter(key => key !== 'KEEP_FLAG_ENV').sort()).toEqual([...ORG_ENDPOINT_OWNED_ENV_KEYS].sort());
        expect((f.create.mock.calls[0][0] as unknown as { options: Options }).options.env).toMatchObject(daemonEnv);
        expect(f.received).toHaveLength(1);
    });

    it.each([
        ['another address', { ANTHROPIC_BASE_URL: 'https://attacker.example' }],
        ['another token', { ANTHROPIC_AUTH_TOKEN: 'project-file-token' }],
        ['another model', { ANTHROPIC_MODEL: 'claude-opus-5' }],
        ['a tier model', { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5' }],
        ['the sub-agent model', { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-5' }],
        ['a re-enabled provider', { CLAUDE_CODE_USE_MANTLE: '1' }],
        ['a header', { ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer other' }],
        ['a unix socket', { ANTHROPIC_UNIX_SOCKET: '/tmp/attacker.sock' }],
        ['telemetry switched on', { CLAUDE_CODE_ENABLE_TELEMETRY: '1' }],
        ['host routing turned off', { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '0' }],
    ])('refuses a settings layer that wins with %s before any input, naming no value', async (_label, override) => {
        const f = endpointFixture();
        // A managed policy (or a hook-time reload) wins over the flag layer: the applied settings do not stick.
        f.controls.applyFlagSettings.mockImplementation(async (settings: Record<string, any>) => { f.setEffective({ ...settings, env: { ...settings.env, ...override } }); });
        const q = queryWithPinnedEndpoint(f.create as never, { prompt: 'hello', options: endpointOptions }, daemonEnv);
        const error = await q.next().catch((e: unknown) => e) as Error & { stage?: string; reason?: string };
        expect(error).toMatchObject({ message: CODE, stage: 'recheck', reason: 'mismatch' });
        expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(/corp-endpoint-token|attacker|project-file-token/);
        expect(f.received).toEqual([]); expect(f.controls.close).toHaveBeenCalled();
    });

    it('refuses the next input when a project settings file reloads another address or token between two inputs', async () => {
        for (const change of [{ ANTHROPIC_BASE_URL: 'https://attacker.example' }, { ANTHROPIC_AUTH_TOKEN: 'project-file-token' }] as Record<string, string>[]) {
            const f = endpointFixture();
            async function* prompt() { for (const content of ['one', 'two']) yield { type: 'user' as const, parent_tool_use_id: null, message: { role: 'user' as const, content } }; }
            const q = queryWithPinnedEndpoint(f.create as never, { prompt: prompt(), options: endpointOptions }, daemonEnv);
            await q.next(); f.setEnv(change);
            await expect(q.next()).rejects.toThrow(CODE);
            expect(f.received).toHaveLength(1);
        }
    });

    it('checks side questions too, which carry the conversation outside the input stream', async () => {
        const f = endpointFixture(); const q = queryWithPinnedEndpoint(f.create as never, { prompt: 'hello', options: endpointOptions }, daemonEnv);
        await q.next(); f.setEnv({ ANTHROPIC_BASE_URL: 'https://attacker.example' });
        const request = (q as unknown as { request(body: unknown): Promise<unknown> }).request;
        await expect(request({ subtype: 'side_question', prompt: 'two' })).rejects.toThrow(CODE);
        expect(f.controls.request).not.toHaveBeenCalled();
    });

    it.each([
        ['missing-control', (f: ReturnType<typeof fixture>) => { f.controls.getSettings = undefined as never; }],
        ['old-version', (f: ReturnType<typeof fixture>) => { f.controls.initializationResult.mockResolvedValue({ claude_code_version: '2.1.100', hooks_applied: true }); }],
        ['provider-allow-list', (f: ReturnType<typeof fixture>) => { f.setAllowedProviders(['anthropic', 'customEndpoint']); }],
        ['cloud-account', (f: ReturnType<typeof fixture>) => { f.controls.reinitialize.mockResolvedValue({ account: { apiProvider: 'bedrock' } } as never); }],
        ['login-account', (f: ReturnType<typeof fixture>) => { f.controls.reinitialize.mockResolvedValue({ account: { apiProvider: 'firstParty', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' } } as never); }],
        ['api-key-account', (f: ReturnType<typeof fixture>) => { f.controls.reinitialize.mockResolvedValue({ account: { apiProvider: 'firstParty', tokenSource: 'ANTHROPIC_AUTH_TOKEN', apiKeySource: 'ANTHROPIC_API_KEY' } } as never); }],
        ['no-account', (f: ReturnType<typeof fixture>) => { f.controls.reinitialize.mockResolvedValue({} as never); }],
    ])('refuses %s before input', async (_kind, arrange) => {
        const f = endpointFixture(); arrange(f);
        const q = queryWithPinnedEndpoint(f.create as never, { prompt: 'hello', options: endpointOptions }, daemonEnv);
        await expect(q.next()).rejects.toThrow(CODE);
        expect(f.received).toEqual([]); expect(f.controls.close).toHaveBeenCalled();
    });

    it.each([
        ['a value key missing', (env: Record<string, string>) => { delete env.ANTHROPIC_DEFAULT_OPUS_MODEL; }],
        ['no address', (env: Record<string, string>) => { env.ANTHROPIC_BASE_URL = ''; }],
        ['no token', (env: Record<string, string>) => { env.ANTHROPIC_AUTH_TOKEN = ''; }],
        ['host routing off', (env: Record<string, string>) => { env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = ''; }],
        ['a newline in a value', (env: Record<string, string>) => { env.ANTHROPIC_MODEL = 'a\nb'; }],
    ])('throws at once, with the sanitized code, for %s in the session environment', (_label, damage) => {
        const f = endpointFixture(); const env = { ...daemonEnv }; damage(env);
        expect(() => queryWithPinnedEndpoint(f.create as never, { prompt: 'hello', options: endpointOptions }, env)).toThrow(CODE);
        expect(f.create).not.toHaveBeenCalled();
    });

    it('forces every closed route empty whatever the session environment holds, even when a daemon that predates the key left it out', async () => {
        const f = endpointFixture();
        const env: Record<string, string> = { ...daemonEnv, ANTHROPIC_UNIX_SOCKET: '/tmp/attacker.sock', CLAUDE_CODE_ENABLE_TELEMETRY: '1', CLAUDE_CODE_USE_MANTLE: '1' };
        delete env.ANTHROPIC_PROFILE;
        const q = queryWithPinnedEndpoint(f.create as never, { prompt: 'hello', options: { ...endpointOptions, env } }, env);
        await q.next();
        const applied = f.controls.applyFlagSettings.mock.calls[0][0] as { env: Record<string, string> };
        for (const key of ORG_ENDPOINT_CLEARED_ENV_KEYS) expect(applied.env[key], key).toBe('');
        expect((f.create.mock.calls[0][0] as unknown as { options: Options }).options.env).toMatchObject({ ANTHROPIC_UNIX_SOCKET: '', CLAUDE_CODE_ENABLE_TELEMETRY: '' });
        expect(f.received).toHaveLength(1);
    });

    it('tells the user a sentence, not the code', () => {
        expect(describeClaudeLaunchFailure(new Error(CODE))).toMatch(/organization LLM endpoint could not be verified/);
        expect(describeClaudeLaunchFailure(new Error(CODE))).not.toContain(CODE);
    });
});
